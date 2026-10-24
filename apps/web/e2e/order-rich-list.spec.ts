import { expect, test } from "@playwright/test";
import { fixture, id } from "./order-review-fixture";
import {
  AssistViewSchema,
  CreateAssistSchema,
  type CreateAssist,
} from "@yummyai/contracts/ai/assist";

test("order lists request thumbnails and open the full version only for image inspection", async ({
  page,
}) => {
  const state = await fixture(page, 1);
  const sourceVersionId = id(301);
  const filePath = `/api/orders/reports/lines/${id(300)}/files/preview-1?versionId=${sourceVersionId}`;
  const mediaRequests: string[] = [];
  await page.route("**/api/order-centers/summaries", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: state.records[0].line.id,
            revision: 1,
            sourceVersionId,
            printSku: null,
            spu: null,
            specification: null,
            designExecutor: "agent",
            fields: [],
            instructions: "",
            blockers: [],
            error: null,
            images: [
              {
                path: filePath,
                label: "Synthetic customer preview",
                selected: false,
                kind: "preview",
              },
            ],
          },
        ],
      },
    }),
  );
  await page.route("**/api/orders/reports/lines/**/files/**", (route) => {
    mediaRequests.push(route.request().url());
    return route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  });
  await page.goto("/orders?stage=pending_review");
  const thumbnail = page.locator(".oc-thumb img");
  await expect(thumbnail).toHaveJSProperty(
    "src",
    new URL(`${filePath}&thumbnail=1`, page.url()).href,
  );
  await expect
    .poll(() =>
      thumbnail.evaluate(
        (element: HTMLImageElement) => element.complete && element.naturalWidth > 0,
      ),
    )
    .toBe(true);
  expect(mediaRequests).toHaveLength(1);
  expect(new URL(mediaRequests[0]).searchParams.get("thumbnail")).toBe("1");
  await page.getByRole("button", { name: "预览 Synthetic customer preview", exact: true }).click();
  await expect(page.locator(".oc-image-dialog img")).toHaveJSProperty(
    "src",
    new URL(filePath, page.url()).href,
  );
  await expect
    .poll(() =>
      mediaRequests.some((url) => new URL(url).pathname + new URL(url).search === filePath),
    )
    .toBe(true);
  expect(new Set(mediaRequests.map((url) => new URL(url).pathname + new URL(url).search))).toEqual(
    new Set([`${filePath}&thumbnail=1`, filePath]),
  );
  await page.getByRole("button", { name: "关闭图片预览", exact: true }).click();
  expect(state.saves).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});

test("pending products support mixed group selection, page retention and explicit filtered selection", async ({
  page,
}) => {
  const state = await fixture(page, 4);
  state.records[1].line.orderId = state.records[0].line.orderId;
  state.records[1].line.externalOrderId = state.records[0].line.externalOrderId;
  state.records[1].line.externalLineId = "2";
  await page.goto("/orders?preparation=pending_review&pageSize=1");
  const group = page.getByRole("checkbox", {
    name: "选择订单 SYNTHETIC-REVIEW-1 的商品",
    exact: true,
  });
  await expect(page.locator(".oc-product-row")).toHaveCount(2);
  const first = page.getByRole("checkbox", {
    name: "选择商品 SYNTHETIC-REVIEW-1 / 1",
    exact: true,
  });
  await expect(first).toBeEnabled();
  await first.check();
  await expect(group).toHaveJSProperty("indeterminate", true);
  await group.check();
  await expect(page.locator(".oc-selection-bar")).toContainText("已选 2 件");
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator(".oc-selection-bar")).toContainText("其他页 2 件");
  await page.getByRole("checkbox", { name: "选择本页商品", exact: true }).check();
  await expect(page.locator(".oc-selection-bar")).toContainText("已选 3 件");
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await expect(first).toBeChecked();
  await page.getByRole("button", { name: "选择全部筛选结果", exact: true }).click();
  await expect(page.locator(".oc-selection-bar")).toContainText("已选 4 件");
  expect(state.saves).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});

test("inline edits keep selection and URL, guard unsaved changes, and show the saved summary", async ({
  page,
}) => {
  const state = await fixture(page, 3);
  await page.goto("/orders?preparation=pending_review&pageSize=2");
  await expect(page.locator(".oc-custom-summary").first()).toContainText("Synthetic name 1");
  await page
    .getByRole("checkbox", { name: "选择商品 SYNTHETIC-REVIEW-1 / 1", exact: true })
    .check();
  await page.getByRole("button", { name: "展开编辑", exact: true }).first().click();
  const inline = page.getByLabel("行内编辑 SYNTHETIC-REVIEW-1 / 1", { exact: true });
  await inline.getByLabel("制作说明", { exact: true }).fill("Edited without leaving the list");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(inline).toBeVisible();
  await expect(page).toHaveURL(/preparation=pending_review&pageSize=2$/);
  await inline.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(inline.getByRole("status")).toContainText("草稿已保存");
  await expect(page.locator(".oc-custom-summary").first()).toContainText(
    "Edited without leaving the list",
  );
  await page.getByRole("button", { name: "收起编辑", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "选择商品 SYNTHETIC-REVIEW-1 / 1", exact: true }),
  ).toBeChecked();
  expect(state.saves).toHaveLength(1);
  expect(state.saves[0].draft.fields).toEqual(state.records[0].draft.fields);
});

test("batch preview is read-only, partial failures stay selected and retry uses the same request", async ({
  page,
}) => {
  const state = await fixture(page, 3);
  state.records[2].line.held = true;
  await page.goto("/orders?preparation=pending_review");
  await page.getByRole("checkbox", { name: "选择本页商品", exact: true }).check();
  await page.getByRole("button", { name: "待补资料", exact: true }).last().click();
  await page.getByRole("button", { name: "预览变更与检查", exact: true }).click();
  await expect(page.getByText("可处理 2 件 · 受阻 / 无需修改 1 件")).toBeVisible();
  expect(state.saves).toEqual([]);
  state.failNextSave();
  await page.getByRole("button", { name: "确认处理 2 件", exact: true }).click();
  await expect(page.getByLabel("批量处理结果")).toContainText("已完成 1 件 · 待处理 1 件");
  await expect(page.locator(".oc-selection-bar")).toContainText("已选 2 件");
  await page.getByRole("button", { name: "确认处理 1 件", exact: true }).click();
  await expect(page.locator(".oc-selection-bar")).toContainText("已选 1 件");
  expect(state.saves[0].idempotencyKey).toBe(state.saves[2].idempotencyKey);
  expect(state.records[0].draft.instructions).toBe("Original instructions 1");
  expect(state.records[2].line.preparation).toBe("pending_review");
});

test("desktop and narrow rows wrap long requests and AI configuration is explicit", async ({
  page,
}, info) => {
  const state = await fixture(page, 2);
  state.records[0].line.title = "Synthetic long product title " + "LongUnbrokenTitle".repeat(20);
  state.records[0].draft.fields[0].value = "LongCustomerRequest".repeat(30);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/orders?preparation=pending_review");
  await expect(page.locator(".oc-custom-summary").first()).toContainText("LongCustomerRequest");
  await page.screenshot({ path: info.outputPath("order-rich-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await page.getByRole("checkbox", { name: "选择本页商品", exact: true }).check();
  await page.getByRole("button", { name: "AI 预审", exact: true }).click();
  await expect(page.getByText("尚未配置分析模型，请先在 AI 设置中添加渠道和模型。")).toBeVisible();
  await expect(page.getByRole("button", { name: "开始本批 AI 预审", exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath("order-rich-mobile.png"), fullPage: true });
  expect(state.saves).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});

test("configured batch AI pins each order and stops later submissions after a failed task", async ({
  page,
}) => {
  const state = await fixture(page, 3),
    calls: CreateAssist[] = [];
  const now = new Date().toISOString();
  const model = {
    id: id(200),
    model: "synthetic-analysis",
    label: "Synthetic analysis model",
    providerLabel: "Test transport",
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
    maxTaskCostUsd: 0.05,
  };
  await page.route("**/api/ai-assists/**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/models"))
      return route.fulfill({ json: [model] });
    const request = CreateAssistSchema.parse(route.request().postDataJSON());
    calls.push(request);
    return route.fulfill({
      json: AssistViewSchema.parse({
        id: id(200 + calls.length),
        kind: "order_review",
        scope: `order:${state.records[calls.length - 1].line.id}`,
        status: calls.length === 1 ? "completed" : "failed",
        createdAt: now,
        completedAt: now,
        modelLabel: model.label,
        model: model.model,
        promptVersion: "synthetic",
        inputFingerprint: "synthetic",
        stale: false,
        maxTaskCostUsd: 0.05,
        request,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        error: calls.length === 1 ? null : "Synthetic provider failure",
        diagnostics: [],
        sources: [],
        checks: [],
        result: null,
        images: [],
      }),
    });
  });
  await page.goto("/orders?preparation=pending_review");
  await page.getByRole("checkbox", { name: "选择本页商品", exact: true }).check();
  await page.getByRole("button", { name: "AI 预审", exact: true }).click();
  await expect(page.getByText(/本批上限 \$0.15/)).toBeVisible();
  await page.getByRole("button", { name: "开始本批 AI 预审", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "已提交 2 / 3 件" })).toBeVisible();
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({
    orderLineId: id(1),
    expectedRevision: 1,
    expectedSourceVersionId: null,
    modelId: model.id,
  });
  expect(calls[1]).toMatchObject({ orderLineId: id(2), expectedRevision: 1 });
  expect(state.saves).toEqual([]);
});
