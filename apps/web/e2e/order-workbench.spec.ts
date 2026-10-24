import { expect, test } from "@playwright/test";
import { fixture, id } from "./order-review-fixture";
import { ArchiveOrderWorkInputSchema } from "@yummyai/contracts/order/workspace";
import { ProductionEditorDetailViewSchema } from "@yummyai/contracts/pod/production-editor-api";

test("queue filters update locally, keep counts visible and support browser history without a page request", async ({
  page,
}) => {
  const state = await fixture(page, 3);
  state.records[0]!.line.artwork = "in_progress";
  state.records[0]!.line.preparation = "pushed";
  let releaseRead!: () => void;
  const heldRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let hold = true,
    entered = false;
  await page.route("**/api/order-centers/workspace?**", async (route) => {
    if (hold && new URL(route.request().url()).searchParams.get("stage") === "in_progress") {
      hold = false;
      entered = true;
      await heldRead;
    }
    await route.fallback();
  });
  await page.goto("/orders?stage=pending_review");
  await expect(page.locator(".oc-product-row")).toHaveCount(2);
  const shell = await page.locator(".oc-queue-region").elementHandle();
  const pending = page.getByRole("button", { name: "待审单", exact: true });
  const progress = page.getByRole("button", { name: "制图中", exact: true });
  const pageRequests: string[] = [],
    workspaceRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.resourceType() === "document" ||
      (url.pathname === "/orders" && request.headers().rsc === "1")
    )
      pageRequests.push(url.pathname);
    if (url.pathname === "/api/order-centers/workspace")
      workspaceRequests.push(url.searchParams.get("stage") ?? "all");
  });
  try {
    await pending.click();
    await expect(pending).toHaveAttribute("aria-pressed", "true");
    await progress.click();
    await expect.poll(() => entered).toBe(true);
    await expect(progress).toHaveAttribute("aria-pressed", "true");
    await expect(pending).toBeEnabled();
    await expect(pending.locator("strong")).toHaveText("2");
    await expect(progress.locator("strong")).toHaveText("1");
    await expect(page.getByRole("button", { name: "全部 3", exact: true })).toBeEnabled();
    expect(await shell!.evaluate((element) => element.isConnected)).toBe(true);
    releaseRead();
    await expect(page.locator(".oc-product-row")).toHaveCount(1);
    await page.goBack();
    await expect(page).toHaveURL(/stage=pending_review/);
    await expect(page.locator(".oc-product-row")).toHaveCount(2);
    await page.goForward();
    await expect(page).toHaveURL(/stage=in_progress/);
    await expect(page.locator(".oc-product-row")).toHaveCount(1);
    expect(workspaceRequests).toEqual(["in_progress", "pending_review", "in_progress"]);
    expect(pageRequests).toEqual([]);
    expect(await shell!.evaluate((element) => element.isConnected)).toBe(true);
    expect(state.saves).toEqual([]);
    expect(state.unexpectedWrites).toEqual([]);
  } finally {
    releaseRead();
  }
});

test("a newer queue selection cancels a slow list response without disabling the status cards", async ({
  page,
}) => {
  const state = await fixture(page, 2);
  state.records[0]!.line.artwork = "in_progress";
  state.records[0]!.line.preparation = "pushed";
  let releaseRead!: () => void;
  const heldRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let entered = false,
    finished = false;
  await page.route("**/api/order-centers/workspace?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("stage") === "in_progress") {
      entered = true;
      await heldRead;
      // A deliberately late response must never replace the newly selected queue.
      await route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25 } }).catch(() => {});
      finished = true;
    } else await route.fallback();
  });
  await page.goto("/orders?stage=pending_review");
  await expect(page.locator(".oc-product-row")).toHaveCount(1);
  try {
    await page.getByRole("button", { name: "制图中", exact: true }).click();
    await expect.poll(() => entered).toBe(true);
    await page.getByRole("button", { name: "全部 2", exact: true }).click();
    await expect(page).toHaveURL(/\/orders$/);
    await expect(page.locator(".oc-product-row")).toHaveCount(2);
    releaseRead();
    await expect.poll(() => finished).toBe(true);
    await expect(page.locator(".oc-workbench")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator(".oc-product-row")).toHaveCount(2);
    expect(state.saves).toEqual([]);
    expect(state.unexpectedWrites).toEqual([]);
  } finally {
    releaseRead();
  }
});

test("pending review recovers from a transient gateway failure after a queue click", async ({
  page,
}) => {
  const state = await fixture(page, 2);
  state.records[0]!.line.artwork = "in_progress";
  state.records[0]!.line.preparation = "pushed";
  let attempts = 0;
  await page.route("**/api/order-centers/workspace?**", async (route) => {
    if (
      new URL(route.request().url()).searchParams.get("stage") === "pending_review" &&
      ++attempts === 1
    )
      await route.fulfill({
        status: 502,
        contentType: "text/html",
        body: "Temporary gateway failure",
      });
    else await route.fallback();
  });
  await page.goto("/orders");
  await expect(page.locator(".oc-product-row")).toHaveCount(2);
  await page.getByRole("button", { name: "待审单", exact: true }).click();
  await expect(page).toHaveURL(/stage=pending_review/);
  await expect(page.locator(".oc-product-row")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "开始审单", exact: true })).toBeVisible();
  await expect(page.locator(".oc-page").getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "制图中", exact: true })).toBeEnabled();
  expect(attempts).toBe(2);
  expect(state.unexpectedWrites).toEqual([]);
});

test("failed queue and options reads keep filters, selected store and explicit retry usable", async ({
  page,
}) => {
  const state = await fixture(page, 2);
  state.records[0]!.line.artwork = "in_progress";
  state.records[0]!.line.preparation = "pushed";
  let failed = true;
  await page.route("**/api/order-centers/options", async (route) => {
    if (failed)
      await route.fulfill({ status: 502, json: { message: "Temporary options failure" } });
    else await route.fallback();
  });
  await page.route("**/api/order-centers/workspace?**", async (route) => {
    if (failed && new URL(route.request().url()).searchParams.get("stage") === "pending_review")
      await route.fulfill({ status: 502, json: { message: "Temporary list failure" } });
    else await route.fallback();
  });
  await page.goto(`/orders?accountId=${id(99)}`);
  await expect(page.locator(".oc-product-row")).toHaveCount(2);
  await expect(page.getByRole("status")).toContainText("其他筛选仍可使用");
  await page.getByRole("button", { name: "待审单", exact: true }).click();
  await expect(page.locator(".oc-page").getByRole("alert")).toContainText("订单列表读取失败");
  await expect(page.getByText("订单数量暂不可用", { exact: true })).toBeVisible();
  await expect(page.getByText("没有符合条件的订单商品。", { exact: true })).toHaveCount(0);
  await expect(page.getByText("共 0 条订单商品", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "查询", exact: true })).toBeEnabled();
  await page.getByLabel("当前环节", { exact: true }).selectOption("in_progress");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page).toHaveURL(/stage=in_progress/);
  await expect(page).toHaveURL(new RegExp(`accountId=${id(99)}`));
  await expect(page.locator(".oc-product-row")).toHaveCount(1);
  await expect(page.locator(".oc-page").getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "待审单", exact: true }).click();
  await expect(page.locator(".oc-page").getByRole("alert")).toContainText("订单列表读取失败");
  failed = false;
  await page.getByRole("button", { name: "重新加载订单", exact: true }).click();
  await expect(page.locator(".oc-product-row")).toHaveCount(1);
  await expect(page.locator(".oc-page").getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("店铺", { exact: true })).toBeEnabled();
  await expect(page.getByLabel("店铺", { exact: true })).toHaveValue(id(99));
  expect(state.unexpectedWrites).toEqual([]);
});

test("artwork progress reports real jobs and never reuses an older version's preflight", async ({
  page,
}) => {
  const state = await fixture(page, 1);
  const record = state.records[0]!;
  record.line.preparation = "pushed";
  record.line.artwork = "in_progress";
  record.line.editorProjectId = id(301);
  const now = "2026-09-15T00:00:00.000Z";
  const prior = { id: id(302), versionNumber: 1, createdAt: now, reviewed: false };
  const current = { id: id(303), versionNumber: 2, createdAt: now, reviewed: false };
  const editor = ProductionEditorDetailViewSchema.parse({
    project: {
      id: id(301),
      name: "Synthetic progress",
      productType: "tire_cover",
      currentVersionId: current.id,
      versionNumber: 2,
      source: null,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    },
    version: {
      ...current,
      document: {
        schemaVersion: 1,
        name: "Synthetic draft",
        productType: "tire_cover",
        layers: [],
        contour: [],
        confirmations: {
          physicalSize: false,
          whiteBorderRule: false,
          narrowParts: false,
          barcodeTab: false,
          backText: false,
          visualReview: false,
        },
        spec: { diameterMm: 600, dpi: 150, safeInsetMm: 10, opening: null },
      },
    },
    versions: [prior, current],
    images: [],
    fonts: [],
    renders: [
      {
        id: id(304),
        versionId: prior.id,
        purpose: "preview",
        status: "completed",
        errorCode: null,
        createdAt: now,
        files: [],
        preflight: { productionReady: true, widthPx: 3543, heightPx: 3543, issues: [] },
      },
      {
        id: id(305),
        versionId: prior.id,
        purpose: "order_image_enhancement",
        status: "failed",
        errorCode: "SYNTHETIC_MODEL_FAILURE",
        createdAt: now,
        files: [],
        preflight: null,
      },
    ],
  });
  await page.route(`**/api/production-editor/projects/${id(301)}`, (route) =>
    route.fulfill({ json: editor }),
  );
  await page.goto(`/orders?line=${record.line.id}&detailMode=artwork`);
  await page.getByText(/文件历史与生成记录（/).click();
  const progress = page.getByRole("region", { name: "制图进度与审核准备" });
  await expect(progress).toContainText("当前稿件 V2");
  await expect(progress).toContainText("顾客图片保真美化");
  await expect(progress).toContainText("失败，需处理");
  await expect(progress).toContainText("当前版本尚无文件校验记录");
  await expect(progress).not.toContainText("最近一次文件校验通过");
  expect(state.unexpectedWrites).toEqual([]);
});

test("archiving accepts a reason, clears the queue and restores a paused record", async ({
  page,
}) => {
  const state = await fixture(page, 1);
  const record = state.records[0]!;
  const originalDraft = structuredClone(record.draft);
  const writes: boolean[] = [];
  await page.route(`**/api/order-centers/lines/${record.line.id}/archive`, async (route) => {
    const input = ArchiveOrderWorkInputSchema.parse(route.request().postDataJSON());
    expect(input.reason).toBe("Synthetic fixture cleanup");
    expect(input.expectedProjectionVersion).toBe(record.line.projectionVersion);
    writes.push(input.archived);
    record.line.archivedAt = input.archived ? new Date().toISOString() : null;
    record.line.held = true;
    record.line.projectionVersion += 1;
    await route.fulfill({ json: record });
  });
  await page.goto(`/orders?line=${record.line.id}`);
  const reason = page.getByLabel("操作原因 / 客户确认依据", { exact: true });
  await reason.fill("Synthetic fixture cleanup");
  await page.getByRole("button", { name: "归档此商品", exact: true }).click();
  await expect(page.getByRole("button", { name: "恢复到订单列表", exact: true })).toBeVisible();
  await expect(page.locator(".oc-product-row")).toHaveCount(0);
  await reason.fill("Synthetic fixture cleanup");
  await page.getByRole("button", { name: "恢复到订单列表", exact: true }).click();
  await expect(page.locator(".oc-product-row")).toHaveCount(1);
  expect(record.line.held).toBe(true);
  expect(record.draft).toEqual(originalDraft);
  expect(writes).toEqual([true, false]);
  expect(state.unexpectedWrites).toEqual([]);
});

test("queue totals cover all pages and selecting a queue preserves the store query", async ({
  page,
}) => {
  const state = await fixture(page, 5);
  state.records[0]!.line.artwork = "in_review";
  state.records[0]!.line.preparation = "pushed";
  await page.goto("/orders?pageSize=1");
  const queues = page.getByRole("navigation", { name: "订单状态统计" });
  await expect(queues.getByRole("button", { name: "待审单", exact: true })).toContainText("4");
  await expect(queues.getByRole("button", { name: "待审图", exact: true })).toContainText("1");
  await queues.getByRole("button", { name: "待审图", exact: true }).click();
  await expect(page).toHaveURL(/stage=in_review/);
  await expect(page.locator(".oc-product-row")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "审核生产图", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "连续审图", exact: true })).toBeVisible();
  await expect(queues.getByRole("button", { name: "待审单", exact: true })).toContainText("4");
  await page.getByRole("button", { name: "审核生产图", exact: true }).click();
  await expect(page).toHaveURL(/detailMode=artwork/);
  await expect(page.getByRole("dialog", { name: "制图中心 · 连续处理" })).toBeVisible();
  expect(state.unexpectedWrites).toEqual([]);
});

test("missing labels is an independent package filter and excludes new unplanned orders", async ({
  page,
}) => {
  const state = await fixture(page, 3);
  state.records[0]!.line.labelStatus = "not_due";
  state.records[1]!.line.labelStatus = "partial";
  state.records[2]!.line.labelStatus = "ready";
  await page.goto("/orders");
  const filter = page.getByRole("button", { name: "缺少面单 1", exact: true });
  await expect(filter).toBeVisible();
  await filter.click();
  await expect(page).toHaveURL(/labelStatus=missing/);
  await expect(page.locator(".oc-product-row")).toHaveCount(1);
  await expect(page.locator(".oc-product-row")).toContainText("SYNTHETIC-SKU-2");
  expect(state.unexpectedWrites).toEqual([]);
});

test("batch order numbers, explicit time type and dual-month range submit together", async ({
  page,
}) => {
  const state = await fixture(page, 3);
  await page.goto("/orders");
  await page.getByRole("button", { name: "更多筛选", exact: true }).click();
  await page
    .getByLabel("批量订单号", { exact: true })
    .fill("SYNTHETIC-REVIEW-1，\nSYNTHETIC-REVIEW-3");
  await page.getByLabel("时间类型", { exact: true }).selectOption("imported");
  await page.getByLabel("选择日期范围", { exact: true }).click();
  await expect(page.locator(".oc-calendar-month")).toHaveCount(2);
  await page.getByLabel("开始日期", { exact: true }).fill("2026-09-01");
  await page.getByLabel("结束日期", { exact: true }).fill("2026-09-15");
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page).toHaveURL(/dateField=imported/);
  await expect(page).toHaveURL(/from=2026-09-01/);
  await expect(page.locator(".oc-product-row")).toHaveCount(2);
  expect(state.unexpectedWrites).toEqual([]);
});

test("failed summaries never invent bindings or an Agent assignment, and can recover", async ({
  page,
}) => {
  const state = await fixture(page, 1);
  state.records[0]!.draft.designExecutor = "human";
  let fail = true;
  await page.route("**/api/order-centers/summaries", async (route) => {
    if (fail) await route.fulfill({ status: 503, json: { message: "Synthetic summary outage" } });
    else await route.fallback();
  });
  await page.goto("/orders");
  const row = page.locator(".oc-product-row");
  await expect(row).toContainText("执行方式读取失败");
  await expect(row).not.toContainText("无人设计 Agent");
  await expect(row).not.toContainText("产品 SPU：待匹配");
  fail = false;
  await page.getByRole("button", { name: "重试摘要", exact: true }).click();
  await expect(row).toContainText("美工设计");
});

test("compact desktop and mobile layouts keep filters and the calendar inside the page", async ({
  page,
}, info) => {
  await fixture(page, 2);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/orders");
  await expect(page.locator(".oc-product-row").first()).toBeVisible();
  expect((await page.locator(".oc-order-group").first().boundingBox())!.y).toBeLessThan(560);
  await page.screenshot({ path: info.outputPath("order-workbench-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("选择日期范围", { exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await expect(page.getByRole("button", { name: "近 7 天", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("order-workbench-mobile.png"), fullPage: true });
});
