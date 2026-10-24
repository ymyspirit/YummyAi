import { expect, test, type Page, type Route } from "@playwright/test";
import { OrderWorkActionInputSchema } from "@yummyai/contracts/order/workspace";
import { AmazonReportDetailViewSchema } from "@yummyai/contracts/order/report";
import {
  ProductionEditorDetailViewSchema,
  type ProductionEditorRenderView,
} from "@yummyai/contracts/pod/production-editor-api";
import {
  createProductionDocument,
  newProductionImage,
} from "../src/features/production-editor/production-editor-model";
import { fixture, id } from "./order-review-fixture";
import { syntheticProductionPng } from "./production-editor-fixture";
import { AssistViewSchema } from "@yummyai/contracts/ai/assist";
import { ARTWORK_AUDIT_POLICY, ArtworkAuditCodeSchema } from "@yummyai/contracts/ai/artwork-audit";

// Isolated in-memory transport for the real orders/artwork UI. API integration
// tests separately cover tenant permissions, immutable versions and review writes.
async function artworkFixture(page: Page, hasPreview = true, count = 1) {
  const state = await fixture(page, count);
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
  await page.route(`**/api/order-centers/lines/${record.line.id}/design-agent`, async (route) => {
    if (route.request().method() !== "GET")
      throw new Error("Synthetic artwork review must not execute the design agent");
    return route.fulfill({ json: { run: null } });
  });
  await page.route(`**/api/production-editor/projects/${id(200)}**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.includes("/files/"))
      return route.fulfill(
        failImage ? { status: 503 } : { contentType: "image/png", body: syntheticProductionPng() },
      );
    if (request.method() === "POST" && path.endsWith("/renders")) {
      const input = request.postDataJSON();
      renders.push(input);
      const render = input.purpose === "production" ? { ...composed, id: id(220), purpose: "production" as const,
        createdAt: "2026-09-15T05:00:00.000Z", files: [{ key: "result", name: "synthetic-production.jpg", mediaType: "image/jpeg", byteSize: 100 }] } : composed;
      editor.renders.push(render);
      return route.fulfill({ json: render });
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
    if (input.action === "approve_artwork") editor.renders.push({ ...composed, id: id(219), purpose: "production", status: "queued", files: [], preflight: null, createdAt: "2026-09-15T05:00:00.000Z" });
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

test("operator task queue moves from artwork review to order review only after successful writes", async ({ page }) => {
  const state = await artworkFixture(page, true, 2);
  await page.goto("/orders");
  await page.getByRole("button", { name: "开始处理订单", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const review = page.getByRole("region", { name: "生产图审核", exact: true });
  await expect(review.getByRole("checkbox", { name: "保存审核结果后处理下一单" })).toBeChecked();
  await expect(review.getByRole("button", { name: "通过审核", exact: true })).toBeEnabled();
  const quickApprove = dialog.getByRole("group", { name: "审图快速操作" }).getByRole("button", { name: "通过审核并下一单", exact: true });
  await expect(quickApprove).toBeVisible();
  state.failNextAction();
  await quickApprove.click();
  await expect(dialog.getByRole("alert").filter({ hasText: "版本状态已变化" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`line=${id(1)}`));
  await quickApprove.click();
  await expect(page).toHaveURL(new RegExp(`line=${id(2)}`));
  await expect(page).not.toHaveURL(/detailMode=artwork/);
  await expect(dialog.getByRole("region", { name: "生产图审核", exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("当前任务")).toContainText("核对买家定制要求");
  const instructions = dialog.getByLabel("制作说明", { exact: true });
  await instructions.fill("Synthetic operator input preserved after conflict");
  state.failNextSave();
  await dialog.getByRole("button", { name: "确认审单并返回列表", exact: true }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "Synthetic save conflict" })).toBeVisible();
  await expect(instructions).toHaveValue("Synthetic operator input preserved after conflict");
  await expect(page).toHaveURL(new RegExp(`line=${id(2)}`));
  await dialog.getByRole("button", { name: "确认审单并返回列表", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "推送设计", exact: true })).toBeVisible();
  expect(state.actions.map(action => action.action)).toEqual(["approve_artwork", "approve_artwork"]);
  expect(state.actions[0]!.idempotencyKey).toBe(state.actions[1]!.idempotencyKey);
  expect(state.renders).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});

for (const outcome of ["passed", "failed"] as const) test(`automatic six-item audit ${outcome}: evidence, explicit approval and version invalidation`, async ({page}) => {
  const state = await artworkFixture(page);
  const codes = ["physical_size_unconfirmed", "visual_review_required", "narrow_parts_unconfirmed", "white_border_unconfirmed", "barcode_rule_unconfirmed", "back_text_unconfirmed"];
  for (const render of state.editor.renders) render.preflight = {productionReady: false, widthPx: 3600, heightPx: 2100, issues: codes.map(code => ({code, message: "Synthetic manual confirmation", severity: "manual"}))};
  let posts = 0, stale = false;
  const run = AssistViewSchema.parse({id: id(600), kind: "artwork_preflight", scope: `order:${state.record.line.id}`, status: "completed", createdAt: "2026-09-20T01:00:00Z", completedAt: "2026-09-20T01:01:00Z", modelLabel: "Synthetic vision", model: "synthetic", maxTaskCostUsd: 1, promptVersion: "fixture", inputFingerprint: "b".repeat(64),
    request: {kind: "artwork_preflight", automaticAudit: true, orderLineId: state.record.line.id, expectedRevision: state.record.line.revision, expectedEditorVersionId: state.editor.version.id, requestId: id(601), modelId: id(602)}, stale: false, inputTokens: 1, outputTokens: 1, costUsd: .01, error: null, sources: [], checks: [], diagnostics: [], result: null,
    images: [{sourceId: "production-preview", label: "核对使用的生产稿", path: `/api/ai-assists/runs/${id(600)}/images/0`}],
    artworkAudit: {policy: ARTWORK_AUDIT_POLICY, complete: true, orderLineId: state.record.line.id, revision: state.record.line.revision, projectId: state.editor.project.id, versionId: state.editor.version.id, versionNumber: 2, documentHash: "a".repeat(64), sourceVersionId: null, factoryStandardId: "ps-pillow-2026-09-17", ruleBasis: "Synthetic pinned rules",
      checks: ArtworkAuditCodeSchema.options.map(code => ({code, title: code === "narrowParts" ? "最窄处不少于 5 厘米" : `核对 ${code}`, status: code === "narrowParts" ? outcome : "passed", method: "measurement", detail: code === "narrowParts" && outcome === "failed" ? "裁线间距 4 厘米，小于 5 厘米。" : "本项符合订单要求。", action: outcome === "failed" && code === "narrowParts" ? "加宽标出的细窄部位。" : "", evidence: ["Synthetic measured evidence"], marks: code === "narrowParts" ? [{sourceId: "production-preview", label: "测量位置", x: .3, y: .2, width: .2, height: .1}] : []}))}});
  await page.route("**/api/ai-assists/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/models")) return route.fulfill({json: [{id: id(602), label: "Synthetic vision", model: "synthetic", providerLabel: "Fixture", inputUsdPerMillion: 0, outputUsdPerMillion: 0, maxTaskCostUsd: 1}]});
    if (path.includes("/images/")) return route.fulfill({contentType: "image/png", body: syntheticProductionPng()});
    if (route.request().method() === "POST") { posts++; expect(route.request().postDataJSON()).toMatchObject({automaticAudit: true, expectedEditorVersionId: state.editor.version.id}); return route.fulfill({json: {...run, status: "queued", artworkAudit: {...run.artworkAudit, complete: false}}}); }
    if (path.endsWith("/runs")) return route.fulfill({json: posts ? [{id: run.id}] : []});
    return route.fulfill({json: {...run, stale, ...(stale ? {artworkAudit: null, images: []} : {})}});
  });
  await page.goto(`/order-artwork?line=${id(1)}`);
  const review = page.getByRole("region", {name: "生产图审核", exact: true});
  const audit = review.getByRole("region", {name: "自动核对", exact: true});
  const approve = review.getByRole("button", {name: "通过审核", exact: true});
  await expect(approve).toBeDisabled(); expect(posts).toBe(0);
  await audit.getByRole("button", {name: "自动核对 6 项", exact: true}).click();
  await expect(audit).toContainText(outcome === "passed" ? "6 项通过，0 项需要处理" : "5 项通过，1 项需要处理");
  if (outcome === "passed") await expect(approve).toBeEnabled(); else await expect(approve).toBeDisabled();
  expect(state.actions).toEqual([]); expect(posts).toBe(1);
  await audit.getByText("查看核对依据与标记位置", {exact: true}).click();
  await expect(audit.getByRole("img", {name: "最窄处不少于 5 厘米：核对使用的生产稿"})).toBeVisible();
  await expect(audit.locator(".oc-audit-mark")).toHaveCount(1);
  await page.setViewportSize({width: 390, height: 844});
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.reload();
  await expect(audit).toContainText("已核对"); expect(posts).toBe(1);
  stale = true; await page.reload();
  await expect(audit).toContainText("原核对结果已失效");
  await expect(approve).toBeDisabled(); expect(state.actions).toEqual([]);
});

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
  expect((await image.boundingBox())!.y + (await image.boundingBox())!.height).toBeLessThan(
    (await page.locator(".oc-review-footer").boundingBox())!.y,
  );
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
  await expect(review.getByText("审核已完成，系统正在后台准备生产文件。你可以继续审核下一单。")).toBeVisible();
  await expect(page.getByRole("button", { name: "生成正式生产文件", exact: true })).toHaveCount(0);
  await expect(review.getByRole("button", { name: "编辑生产文件", exact: true })).toHaveCount(0);
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

test("approved file handoff survives reload and the production center recovers legacy exports with factory JPG defaults", async ({ page }) => {
  const state = await artworkFixture(page);
  state.record.line.artwork = "approved";
  state.record.profile!.instructions = "旧模板条码框 500 × 180 px";
  state.editor.version.reviewed = true;
  const formal: ProductionEditorRenderView = { ...state.editor.renders[0]!, id: id(219), versionId: state.editor.version.id, purpose: "production", status: "queued", files: [], preflight: null };
  state.editor.renders.push(formal);
  await page.goto(`/order-artwork?line=${id(1)}`);
  const review = page.getByRole("region", { name: "生产图审核", exact: true });
  await expect(review).toContainText("系统正在后台准备生产文件");
  await page.reload();
  await expect(review).toContainText("系统正在后台准备生产文件");
  expect(state.renders).toEqual([]);
  formal.status = "completed";
  formal.preflight = { productionReady: true, widthPx: 3600, heightPx: 2100, issues: [] };
  formal.files = [{ key: "result", name: "synthetic-production.jpg", mediaType: "image/jpeg", byteSize: 100 }];
  await page.reload();
  await expect(review).toContainText("生产文件已准备好，等待生产人员安排");
  // An old already-approved order has no automatically queued production render.
  state.editor.renders = state.editor.renders.filter(render => render.purpose !== "production");
  await page.route(`**/api/order-centers/lines/${id(1)}/operations`, route => route.fulfill({ json: { production: [], shipments: [], cases: [] } }));
  await page.goto(`/production?line=${id(1)}`);
  await expect(page.getByText("审核已通过，尚未生成正式生产文件。由制图或生产人员补齐，无需运营再次操作。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "补齐生产文件", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "正式生产文件", exact: true })).toBeVisible();
  const instructions = page.getByRole("textbox", { name: "工厂制作说明", exact: true });
  await expect(instructions).toHaveValue(/空白条码框 600 × 200 px/);
  await expect(instructions).not.toHaveValue(/500 × 180/);
  await expect(instructions).toHaveValue(/Original instructions 1/);
  expect(state.renders).toEqual([{ expectedVersionId: state.editor.version.id, purpose: "production", format: "jpeg", background: "white" }]);
  expect(state.record.line.production).toBe("not_released");
  expect(state.actions).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});

test("artwork center refuses stale images and failed loads, generates only the current white preview, and shows quality blockers", async ({
  page,
}, testInfo) => {
  const state = await artworkFixture(page, false);
  const image = {
    id: id(215),
    version: 1 as const,
    name: "Synthetic low-resolution source",
    mediaType: "image/png",
    width: 512,
    height: 512,
    hasAlpha: false,
    actualAlpha: false,
    checksumSha256: "b".repeat(64),
    byteSize: 100,
    previewPath: `/api/production-editor/projects/${id(200)}/images/${id(215)}?kind=preview`,
    originalPath: `/api/production-editor/projects/${id(200)}/images/${id(215)}?kind=original`,
  };
  const layer = newProductionImage(state.editor.version.document, image);
  state.editor.version.document.layers = [layer];
  state.editor.images = [image];
  await page.route(`**/api/production-editor/projects/${id(200)}/images/${image.id}*`, (route) => {
    expect(route.request().method()).toBe("GET");
    return route.fulfill({ contentType: "image/png", body: syntheticProductionPng() });
  });
  await page.route("**/api/creative-studio/rpc", (route) => {
    expect(route.request().postDataJSON().operation).toBe("models");
    return route.fulfill({ json: [] });
  });
  state.failImages(true);
  await page.goto(`/order-artwork?line=${id(1)}&queue=${id(1)}`);
  const review = page.getByRole("region", { name: "生产图审核", exact: true });
  await expect(review.getByText("当前版本尚无可查看的生产图")).toBeVisible();
  await expect(review.getByRole("img", { name: /^当前生产图/ })).toHaveCount(0);
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
      {
        code: "physical_size_unconfirmed",
        severity: "manual",
        message: "请核对并确认工厂要求的实际毫米尺寸与测量基准。",
      },
      {
        code: "insufficient_image_resolution",
        severity: "error",
        message: "原图按当前放置尺寸约 122 PPI，低于目标 150 PPI；修改 DPI 标签不会增加细节。",
        layerId: layer.id,
      },
      {
        code: "manual_factory_preflight",
        severity: "warning",
        message:
          "白边适用规则、成品尺寸、细窄部位和缝制结果依据人工确认；自动检查不能代替工厂工艺确认。",
      },
    ],
  };
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  const checks = review.getByRole("region", { name: "文件检查", exact: true });
  await expect(
    checks.getByText("需处理 2 项：1 项需修复、1 项待确认。", { exact: true }),
  ).toBeVisible();
  const repairs = checks.getByRole("region", { name: "需修复", exact: true });
  const confirmations = checks.getByRole("region", { name: "待人工确认", exact: true });
  const warnings = checks.getByRole("region", { name: "工艺提醒（不阻止审核）", exact: true });
  for (const group of [repairs, confirmations, warnings]) {
    await expect(group.getByRole("heading")).toContainText("1 项");
    await expect(group.getByRole("listitem")).toHaveCount(1);
    await expect(group.getByRole("listitem")).toBeVisible();
  }
  await expect(repairs).toContainText("122 PPI");
  await expect(repairs).toContainText(`涉及图层：${image.name}`);
  await expect(repairs).toContainText("保持订单尺寸和图案比例");
  await expect(confirmations).toContainText("实际尺寸尚未确认");
  await expect(warnings).toContainText("非阻断提醒");
  await expect(warnings.getByRole("button")).toHaveCount(0);
  await expect(checks.locator("details")).toHaveCount(0);
  expect(
    await checks
      .getByRole("list")
      .evaluateAll((elements) =>
        elements.every((element) => element.scrollHeight <= element.clientHeight + 1),
      ),
  ).toBe(true);
  await checks.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("artwork-actionable-checks.png") });
  await expect(review.getByRole("button", { name: "通过审核", exact: true })).toBeDisabled();
  const documentBeforeNavigation = structuredClone(state.editor.version.document);
  await repairs.getByRole("button", { name: "去修复：图片清晰度不足", exact: true }).click();
  const session = page.getByRole("region", { name: "当前任务生产作图", exact: true });
  await expect(session).toBeVisible();
  await expect(session.getByRole("tab", { name: "图层", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(session.getByLabel("图层名称", { exact: true })).toHaveValue(image.name);
  await session.getByRole("button", { name: "返回制图任务", exact: true }).click();
  await expect(checks).toBeVisible();
  await confirmations
    .getByRole("button", { name: "去核对：实际尺寸尚未确认", exact: true })
    .click();
  await expect(session.getByRole("tab", { name: "预检确认", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    session.getByLabel("实际尺寸与尺寸口径已由工厂确认", { exact: true }),
  ).not.toBeChecked();
  await session.getByRole("button", { name: "返回制图任务", exact: true }).click();
  await expect(checks).toBeVisible();
  expect(state.editor.version.document).toEqual(documentBeforeNavigation);

  // Warnings remain visible after all blocking findings have been resolved.
  const unknownMessage = "合成的新工艺提醒：请核查保留的原始结果，不能丢弃未知问题。";
  composed.preflight = {
    ...composed.preflight,
    productionReady: true,
    issues: [
      composed.preflight.issues.find((issue) => issue.code === "manual_factory_preflight")!,
      { code: "synthetic_future_check", severity: "warning", message: unknownMessage },
    ],
  };
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await expect(
    checks.getByText("文件检查通过，请核对图案、尺寸与客户要求。", { exact: true }),
  ).toBeVisible();
  await expect(repairs).toHaveCount(0);
  await expect(confirmations).toHaveCount(0);
  await expect(warnings.getByRole("heading")).toContainText("2 项");
  const unknown = warnings.getByRole("listitem").filter({ hasText: unknownMessage });
  await expect(unknown.getByText(unknownMessage, { exact: true })).toBeVisible();
  await expect(unknown).toContainText("处理方法：");
  await expect(unknown).toContainText("无法判断时交还制图者处理");
  await expect(unknown).toContainText("生产编辑器 → 预检与出图 → 检查生产参数");
  await expect(review.getByRole("button", { name: "通过审核", exact: true })).toBeEnabled();
  expect(state.actions).toEqual([]);
  expect(state.saves).toEqual([]);
  expect(state.renders).toHaveLength(1);
  expect(state.unexpectedWrites).toEqual([]);
});

const longCustomerNote = `顾客备注：请保留左耳和胸前毛色；特殊文字 <script>window.syntheticCustomerScript = true</script> & "原样保留"。${"CUSTOMER_REQUIREMENT_LONG_TOKEN_".repeat(16)}最后一句也必须完整显示。`;

test("subject measurement compares real alpha bounds and placement with pinned buyer size without changing approval", async ({ page }, testInfo) => {
  const state = await customerRequirementsFixture(page, true);
  const document = state.editor.version.document;
  if (document.productType !== "shaped_pillow") throw new Error("fixture");
  document.spec.artworkClipMode = "none";
  // The fixture's ellipse occupies 369 vertical pixels in a 512-pixel source.
  const imageId = id(460), bytes = syntheticProductionPng(512, true);
  const layer = newProductionImage(document, { id: imageId, version: 1, name: "合成透明主体", width: 512, height: 512 });
  layer.widthMm = layer.heightMm = 512 / 369 * 304.8;
  document.layers = [layer];
  state.editor.images.push({ id: imageId, version: 1, name: "合成透明主体.png", mediaType: "image/png", width: 512, height: 512,
    hasAlpha: true, actualAlpha: true, checksumSha256: "a".repeat(64), byteSize: bytes.length,
    originalPath: `/api/production-editor/projects/${id(200)}/images/${imageId}?kind=original`, previewPath: `/api/production-editor/projects/${id(200)}/images/${imageId}` });
  state.record.sourceReport!.surfaces[0]!.fields.push({ key: "buyer-size", label: "Size", kind: "choice", value: "12 inch" });
  state.record.report!.surfaces[0]!.fields.push({ key: "buyer-size", label: "Size", kind: "choice", value: "24 inch" });
  const before = structuredClone(document);
  let fail = true;
  await page.route(`**/api/production-editor/projects/${id(200)}/images/${imageId}?kind=original`, route => {
    expect(route.request().method()).toBe("GET");
    return route.fulfill(fail ? { status: 503 } : { contentType: "image/png", body: bytes });
  });
  await page.goto(`/orders?line=${id(1)}&detailMode=artwork`);
  const measurement = page.getByRole("region", { name: "主体尺寸核对", exact: true });
  await expect(measurement).toContainText("顾客下单（最长边）12 英寸30.48 厘米");
  await expect(measurement.getByRole("alert")).toContainText("读取主体素材失败");
  fail = false;
  await measurement.getByRole("button", { name: "重新测量" }).click();
  await expect(measurement.locator(".oc-subject-result")).toContainText("尺寸一致");
  await expect(measurement.locator(".oc-subject-result")).toContainText("按图案的高度核对");
  await expect(measurement.getByText("图片放大后可能模糊", { exact: false })).toBeVisible();
  await expect(measurement).toContainText("平台资料已有更新");
  await expect(measurement).not.toContainText("24 英寸");
  await expect(measurement.getByRole("img", { name: "当前图案尺寸示意图" })).toBeVisible();
  await expect(measurement.getByText("高 30.48 厘米", { exact: true })).toBeVisible();
  await expect(measurement.locator("svg rect")).toHaveAttribute("height", "369");
  const technical = measurement.locator(".oc-subject-technical");
  await expect(technical.getByText(/Alpha ≥ 32/)).not.toBeVisible();
  await technical.getByText("像素与测量详情（供制图人员查看）", { exact: true }).click();
  await expect(technical.getByText("30.75 PPI", { exact: true })).toBeVisible();
  await expect(technical.getByText(/Alpha ≥ 32/)).toBeVisible();
  await technical.getByText("像素与测量详情（供制图人员查看）", { exact: true }).click();
  await measurement.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("subject-measurement-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await measurement.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("subject-measurement-mobile.png") });
  expect(document).toEqual(before);
  expect(state.actions).toEqual([]); expect(state.saves).toEqual([]); expect(state.renders).toEqual([]);

  // A new immutable version must invalidate the prior measurement.
  state.editor.version = { ...state.editor.version, id: id(461), versionNumber: 3, document: structuredClone(document) };
  state.editor.project.currentVersionId = id(461);
  state.editor.version.document.layers = [{ ...layer, widthMm: layer.widthMm * .8, heightMm: layer.heightMm * .8 }];
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await expect(measurement).toContainText("当前图案（最长边）9.6 英寸24.38 厘米");
  await expect(measurement.locator(".oc-subject-result")).toContainText("尺寸不一致，需修改");
  await expect(measurement.locator(".oc-subject-result")).toContainText("偏小 6.1 厘米");
  await expect(measurement.locator(".oc-subject-result")).not.toContainText("尺寸一致");
  expect(state.actions).toEqual([]); expect(state.saves).toEqual([]);
});

async function customerRequirementsFixture(page: Page, changed = false) {
  const state = await artworkFixture(page);
  const { record } = state;
  const report = AmazonReportDetailViewSchema.parse({
    line: {
      id: id(400),
      orderId: record.line.orderId,
      orderLineId: record.line.id,
      externalOrderId: record.line.externalOrderId,
      externalLineId: record.line.externalLineId,
      skuCode: record.line.skuCode,
      title: record.line.title,
      quantity: 1,
      currency: null,
      itemTotalMinor: null,
      state: "ready",
      versionNumber: 1,
      reviewed: true,
      lastErrorCode: null,
      updatedAt: "2026-09-15T00:00:00.000Z",
      hasPreview: true,
    },
    surfaces: [
      {
        key: "front",
        label: "正面",
        fields: [
          {
            key: "front-text",
            label: "顾客刻字",
            kind: "text",
            value: "原始正面要求：Ada & Lin",
            font: "Synthetic Source Serif",
            color: "#336699",
          },
          { key: "original-note", label: "顾客原始备注", kind: "text", value: longCustomerNote },
        ],
        previewFileKey: "preview-front",
        buyerFileKeys: ["buyer-front"],
      },
      {
        key: "back",
        label: "背面",
        fields: [
          {
            key: "back-text",
            label: "背面留言",
            kind: "text",
            value: "原始背面要求：Keep the tail",
          },
        ],
        previewFileKey: "preview-back",
        buyerFileKeys: [],
      },
    ],
    files: [
      {
        key: "buyer-front",
        name: "first-original.png",
        mediaType: "image/png",
        role: "buyer_image",
        originalFileKey: "source-front",
        byteSize: 100,
        width: 512,
        height: 512,
      },
      {
        key: "source-front",
        name: "source/first-original.png",
        mediaType: "image/png",
        role: "source",
        byteSize: 100,
        width: 512,
        height: 512,
      },
      {
        key: "preview-front",
        name: "front-preview.png",
        mediaType: "image/png",
        role: "preview",
        byteSize: 100,
        width: 512,
        height: 512,
      },
      {
        key: "preview-back",
        name: "back-preview.png",
        mediaType: "image/png",
        role: "preview",
        byteSize: 100,
        width: 512,
        height: 512,
      },
    ],
    warnings: [],
    versionId: id(401),
  });
  record.line.reportLineId = report.line.id;
  record.line.sourceChanged = changed;
  record.line.specificationName = "14英寸 · 双面";
  record.versions = [
    { id: id(413), revision: record.line.revision, createdAt: "2026-09-15T00:00:00.000Z" },
  ];
  state.editor.project.workSource = { workItemId: record.line.id, revisionId: id(413) };
  record.draft.fields = [
    { key: "crop_scope", label: "裁切范围", kind: "choice", value: "half_body" },
    { key: "print_sides", label: "印刷面数", kind: "choice", value: "double_sided" },
    {
      key: "name",
      label: "定制文字",
      kind: "text",
      value: "本次稿件：Ada & Lin",
      font: "Synthetic Review Serif",
      color: "#AA00CC",
    },
  ];
  record.draft.instructions = `制作说明：保留现有颜色，不增加装饰。${longCustomerNote}`;
  record.draft.specificationVersionId = id(410);
  record.draft.images = [
    { origin: "report", key: "buyer-front", usage: "buyer_photo" },
    { origin: "upload", key: id(411), usage: "back_photo" },
  ];
  record.assets = [
    {
      id: id(411),
      name: "second-original.png",
      mediaType: "image/png",
      width: 512,
      height: 512,
      checksum: "a".repeat(64),
      path: `/api/order-centers/lines/${record.line.id}/images/${id(411)}`,
    },
  ];
  record.catalog = {
    status: "pinned",
    packageId: null,
    recipes: [],
    artworks: [],
    specifications: [
      {
        id: id(410),
        spuId: id(412),
        spuCode: "SYNTHETIC-PILLOW",
        spuName: "合成来图抱枕",
        name: "14英寸 · 双面",
        version: 1,
        processProfileVersionId: record.draft.printProfileVersionId!,
        processName: "合成工艺",
        dimensions: "主体最长边 14 英寸 / 355.6 mm",
      },
    ],
  };
  Object.assign(record, { sourceReport: report, sourceVersionId: report.versionId });
  record.report = structuredClone(report);
  if (changed) {
    record.report.versionId = id(402);
    record.report.line.versionNumber = 2;
    record.report.surfaces[0]!.fields[0]!.value = "LATEST-ONLY-不得冒充当前稿件的顾客要求";
  }
  const imageRequests: string[] = [];
  const failures = new Set<string>();
  const serveImage = async (route: Route) => {
    if (route.request().method() !== "GET")
      throw new Error("Synthetic customer image route must be read-only");
    imageRequests.push(route.request().url());
    const failed = [...failures].some((marker) => route.request().url().includes(marker));
    return route.fulfill(
      failed ? { status: 503 } : { contentType: "image/png", body: syntheticProductionPng() },
    );
  };
  await page.route(`**/api/order-centers/lines/${record.line.id}/report-images/**`, serveImage);
  await page.route(`**/api/order-centers/lines/${record.line.id}/source-files/**`, serveImage);
  await page.route(`**/api/order-centers/lines/${record.line.id}/images/**`, serveImage);
  await page.route(`**/api/orders/reports/lines/${report.line.id}/files/**`, serveImage);
  return {
    ...state,
    report,
    imageRequests,
    failCustomerImage: (marker: string, failed: boolean) => {
      if (failed) failures.add(marker);
      else failures.delete(marker);
    },
  };
}

test("customer requirements are visible beside the current artwork with complete escaped text, both surfaces and image zoom", async ({
  page,
}, testInfo) => {
  const state = await customerRequirementsFixture(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/orders?stage=in_review&line=${id(1)}&queue=${id(1)}&detailMode=artwork`);
  const review = page.getByRole("region", { name: "生产图审核", exact: true });
  const requirements = review.getByRole("region", { name: "顾客定制信息", exact: true });
  await expect(requirements).toBeVisible();
  await expect(requirements.getByRole("heading", { name: /^本次制作要求/ })).toBeInViewport();
  const currentSheet = review.getByRole("img", { name: "当前生产图 V2" });
  await expect(currentSheet).toBeInViewport();
  expect(
    (await currentSheet.boundingBox())!.y + (await currentSheet.boundingBox())!.height,
  ).toBeLessThan((await page.locator(".oc-review-footer").boundingBox())!.y);
  await expect(requirements).toContainText("14英寸 · 双面");
  await expect(requirements).toContainText("半身");
  await expect(requirements).toContainText("双面印刷");
  await expect(requirements).toContainText("本次稿件：Ada & Lin");
  await expect(requirements).toContainText("Synthetic Review Serif");
  await expect(requirements).toContainText("#AA00CC");
  await expect(requirements).toContainText("制作说明：保留现有颜色，不增加装饰。");
  await expect(requirements).toContainText(longCustomerNote);
  await expect(requirements.getByRole("heading", { name: /^顾客原始选项/ })).toBeVisible();
  await expect(requirements).toContainText("原始正面要求：Ada & Lin");
  await expect(requirements).toContainText("原始背面要求：Keep the tail");
  await expect(requirements).toContainText("Synthetic Source Serif");
  await expect(requirements).toContainText("#336699");
  await expect(requirements.locator("script")).toHaveCount(0);
  await expect(requirements.getByText("本次选用原图", { exact: true })).toBeVisible();
  await expect(requirements.getByText("平台定制预览", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("customer-requirements-desktop.png") });
  for (const name of [
    "顾客原图：first-original.png",
    "顾客原图：second-original.png",
    "平台定制预览：正面",
    "平台定制预览：背面",
  ]) {
    await requirements.getByRole("button", { name: `放大 ${name}`, exact: true }).click();
    const enlarged = page.getByRole("dialog", { name: "定制图片放大预览", exact: true });
    await expect(enlarged).toBeVisible();
    await expect(enlarged.getByRole("img")).toBeVisible();
    await expect(enlarged.getByRole("img")).toHaveJSProperty("naturalWidth", 512);
    await page.keyboard.press("Escape");
    await expect(enlarged).not.toBeVisible();
    await expect(review).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await requirements.getByRole("heading", { name: /^本次制作要求/ }).scrollIntoViewIfNeeded();
  for (const selector of [".oc-review-body", ".oc-artwork-review"]) {
    const overflow = await page
      .locator(selector)
      .evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  }
  expect(
    await requirements.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("customer-requirements-mobile.png") });
  await requirements
    .getByRole("button", { name: "放大 顾客原图：second-original.png", exact: true })
    .click();
  const mobilePreview = page.getByRole("dialog", { name: "定制图片放大预览", exact: true });
  await expect(mobilePreview).toBeVisible();
  expect(
    await mobilePreview.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  await expect(
    mobilePreview.getByRole("button", { name: "关闭预览", exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("customer-requirements-mobile-zoom.png") });
  await mobilePreview.getByRole("button", { name: "关闭预览", exact: true }).click();
  await expect(review).toBeVisible();
  expect(state.actions).toEqual([]);
  expect(state.renders).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
  expect(errors).toEqual([]);
});

test("artwork review keeps pinned customer evidence when newer requirements arrive and retries failed private images", async ({
  page,
}) => {
  const state = await customerRequirementsFixture(page, true);
  state.failCustomerImage("source-files/buyer-front", true);
  await page.goto(`/order-artwork?line=${id(1)}&queue=${id(1)}`);
  const review = page.getByRole("region", { name: "生产图审核", exact: true });
  const requirements = review.getByRole("region", { name: "顾客定制信息", exact: true });
  await expect(requirements.getByText(/顾客资料已有更新/)).toBeVisible();
  await expect(requirements).toContainText("原始正面要求：Ada & Lin");
  await expect(requirements).not.toContainText("LATEST-ONLY-不得冒充当前稿件的顾客要求");
  await requirements
    .getByRole("region", { name: "本次选用原图", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(requirements.getByText("图片暂不可用", { exact: false }).first()).toBeVisible();
  state.failCustomerImage("source-files/buyer-front", false);
  await requirements
    .getByRole("button", { name: "重试 顾客原图：first-original.png", exact: true })
    .click();
  const firstOriginal = requirements.getByRole("button", {
    name: "放大 顾客原图：first-original.png",
    exact: true,
  });
  await expect(firstOriginal).toBeEnabled();
  await firstOriginal.click();
  const enlarged = page.getByRole("dialog", { name: "定制图片放大预览", exact: true });
  await expect(enlarged.getByRole("img")).toHaveJSProperty("naturalWidth", 512);
  await enlarged.getByRole("button", { name: "关闭预览", exact: true }).click();
  await expect(enlarged).not.toBeVisible();
  expect(
    state.imageRequests.filter((url) => url.includes("source-files/buyer-front")).length,
  ).toBeGreaterThanOrEqual(2);
  await requirements
    .getByRole("region", { name: "平台定制预览", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    requirements.getByRole("img", { name: "平台定制预览：正面", exact: true }),
  ).toHaveJSProperty("naturalWidth", 512);
  const platformRequests = state.imageRequests.filter((url) =>
    url.includes("/source-files/preview-"),
  );
  expect(platformRequests.length).toBeGreaterThan(0);
  expect(
    platformRequests.every(
      (url) => new URL(url).searchParams.get("revision") === String(state.record.line.revision),
    ),
  ).toBe(true);
  expect(state.actions).toEqual([]);
  expect(state.renders).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});

test("unavailable pinned customer evidence is explicit and does not fall back to a newer report", async ({
  page,
}) => {
  const state = await customerRequirementsFixture(page, true);
  Object.assign(state.record, { sourceReport: null });
  await page.goto(`/order-artwork?line=${id(1)}&queue=${id(1)}`);
  const requirements = page
    .getByRole("region", { name: "生产图审核", exact: true })
    .getByRole("region", { name: "顾客定制信息", exact: true });
  await expect(requirements).toBeVisible();
  await expect(
    requirements.getByText(/资料.*不可用|资料.*无法|未.*原始.*资料/).first(),
  ).toBeVisible();
  await expect(requirements).toContainText("本次稿件：Ada & Lin");
  await expect(requirements).not.toContainText("LATEST-ONLY-不得冒充当前稿件的顾客要求");
  await expect(requirements.getByRole("button", { name: /^放大 平台定制预览/ })).toHaveCount(0);
  expect(state.actions).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});

test("artwork review refuses current requirements for a sheet pinned to a different revision", async ({
  page,
}) => {
  const state = await customerRequirementsFixture(page);
  state.editor.project.workSource = { workItemId: state.record.line.id, revisionId: id(414) };
  await page.goto(`/order-artwork?line=${id(1)}&queue=${id(1)}`);
  const review = page.getByRole("region", { name: "生产图审核", exact: true });
  const requirements = review.getByRole("region", { name: "顾客定制信息", exact: true });
  await expect(requirements.getByRole("alert")).toContainText(
    "此稿件关联的制作需求与当前需求版本不同",
  );
  await expect(requirements).not.toContainText("本次稿件：Ada & Lin");
  await expect(requirements.getByRole("button", { name: /^放大 / })).toHaveCount(0);
  await expect(review.getByRole("img", { name: "当前生产图 V2" })).toBeVisible();
  await expect(review.getByRole("button", { name: "通过审核", exact: true })).toBeDisabled();
  await expect(review.getByLabel("驳回理由", { exact: true })).toBeDisabled();
  expect(state.actions).toEqual([]);
  expect(state.renders).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});
