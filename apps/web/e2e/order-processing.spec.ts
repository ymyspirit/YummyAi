import { expect, test, type Page } from "@playwright/test";
import { OrderWorkActionInputSchema } from "@yummyai/contracts/order/workspace";
import { fixture, id } from "./order-review-fixture";

test("processing waits for business records before accepting a submit", async ({ page }) => {
  const state = await fixture(page, 2);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/order-centers/lines/*/operations", async (route) => {
    await pending;
    return route.fulfill({ json: { production: [], shipments: [], cases: [] } });
  });
  let writes = 0;
  await page.route("**/api/order-centers/lines/*/cases", (route) => {
    writes += 1;
    return route.fulfill({ json: {} });
  });
  await page.goto(`/after-sales?line=${state.records[0].line.id}`);
  const drawer = page.getByRole("dialog", { name: "售后中心 · 连续处理" });
  try {
    await expect(drawer.getByRole("button", { name: "登记售后", exact: true })).toBeDisabled();
    await expect(drawer.getByRole("button", { name: "下一单", exact: true })).toBeDisabled();
    await drawer.getByLabel("原因分类", { exact: true }).fill("SYNTHETIC");
    await drawer.getByLabel("问题说明", { exact: true }).fill("Preserved during record loading");
  } finally {
    release();
  }
  await drawer.getByRole("button", { name: "登记售后", exact: true }).click();
  await expect(drawer.getByText("售后问题已登记。", { exact: true })).toBeVisible();
  expect(writes).toBe(1);
});

async function artworkFixture(page: Page) {
  const state = await fixture(page, 2);
  state.records.forEach((record) => {
    record.line.preparation = "pushed";
    record.line.artwork = "approved";
    record.line.proof = "pending";
    record.draft.customerApprovalRequired = true;
  });
  const actions: ReturnType<typeof OrderWorkActionInputSchema.parse>[] = [];
  let fail = false;
  let pending: Promise<void> | undefined;
  let release: (() => void) | undefined;
  await page.route("**/api/order-centers/lines/*/actions", async (route) => {
    const input = OrderWorkActionInputSchema.parse(route.request().postDataJSON());
    actions.push(input);
    await pending;
    if (fail) {
      fail = false;
      return route.fulfill({ status: 409, json: { message: "Synthetic processing conflict" } });
    }
    const lineId = new URL(route.request().url()).pathname.split("/").at(-2);
    const record = state.records.find((record) => record.line.id === lineId)!;
    record.line.proof = input.action === "approve_proof" ? "approved" : "changes_requested";
    record.line.projectionVersion += 1;
    return route.fulfill({ json: record });
  });
  return {
    ...state,
    actions,
    failNext: () => {
      fail = true;
    },
    hold: () => {
      pending = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => {
      release?.();
      pending = undefined;
    },
  };
}

test("artwork keeps its queue and unsaved confirmation evidence", async ({ page }, testInfo) => {
  const state = await artworkFixture(page);
  await page.goto("/order-artwork?q=SYNTHETIC");
  await page.getByRole("button", { name: "连续处理", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "制图中心 · 连续处理" });
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-1" })).toBeVisible();
  const table = await page.locator(".oc-table").elementHandle();
  await drawer.getByText("处理与交接", { exact: true }).click();
  await drawer
    .getByLabel("操作原因 / 客户确认依据", { exact: true })
    .fill("Synthetic customer confirmation");
  page.once("dialog", (dialog) => dialog.dismiss());
  await drawer.getByRole("button", { name: "下一单", exact: true }).click();
  await expect(drawer.getByLabel("操作原因 / 客户确认依据", { exact: true })).toHaveValue(
    "Synthetic customer confirmation",
  );
  state.failNext();
  await drawer.getByRole("button", { name: "记录客户确认并下一单", exact: true }).click();
  await expect(drawer.getByRole("alert")).toContainText("Synthetic processing conflict");
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-1" })).toBeVisible();
  await drawer.getByRole("button", { name: "记录客户确认并下一单", exact: true }).click();
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-2" })).toBeVisible();
  expect(state.actions[0].idempotencyKey).toBe(state.actions[1].idempotencyKey);
  await expect(drawer.getByLabel("操作原因 / 客户确认依据", { exact: true })).toHaveValue("");
  await page.screenshot({ path: testInfo.outputPath("artwork-queue-desktop.png") });
  await drawer.getByRole("button", { name: "返回制图中心", exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByLabel("搜索订单", { exact: true })).toHaveValue("SYNTHETIC");
  expect(await table?.evaluate((el) => el === document.querySelector(".oc-table"))).toBe(true);
});

test("artwork customer confirmation locks switching until success and finishes the last item", async ({
  page,
}, testInfo) => {
  const state = await artworkFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/order-artwork?line=${state.records[1].line.id}`);
  const drawer = page.getByRole("dialog", { name: "制图中心 · 连续处理" });
  await expect(drawer.getByText("本页 2 / 2", { exact: true })).toBeVisible();
  await drawer.getByText("处理与交接", { exact: true }).click();
  await drawer
    .getByLabel("操作原因 / 客户确认依据", { exact: true })
    .fill("Synthetic final confirmation");
  await expect(
    drawer.getByRole("button", { name: "记录客户确认并返回列表", exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("artwork-queue-mobile.png") });
  state.hold();
  try {
    await drawer.getByRole("button", { name: "记录客户确认并返回列表", exact: true }).click();
    await expect(drawer.getByRole("button", { name: "上一单", exact: true })).toBeDisabled();
    await expect(drawer.getByRole("button", { name: "返回制图中心", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeVisible();
  } finally {
    state.release();
  }
  await expect(drawer).toHaveCount(0);
  expect(state.records[1].line.proof).toBe("approved");
});

test("production protects unsaved forms and advances only after the selected operation succeeds", async ({
  page,
}) => {
  const state = await fixture(page, 2);
  state.records.forEach((record) => {
    record.line.preparation = "pushed";
    record.line.artwork = "approved";
    record.line.production = "planned";
  });
  const operations = state.records.map((_, index) => ({
    production: [
      {
        productionOrder: {
          id: id(300 + index),
          supplierId: id(400),
          status: "planned",
          projectionVersion: 1,
          currentVersionNumber: 1,
          expectedCompletionAt: "2026-09-18T00:00:00Z",
        },
        versions: [
          {
            id: id(500 + index),
            versionNumber: 1,
            quantity: 1,
            sourceEditorProjectId: null,
            sourceEditorVersionId: null,
            sourceRenderId: null,
          },
        ],
        milestones: [],
        inspections: [],
        defects: [],
      },
    ],
    shipments: [],
    cases: [],
  }));
  await page.route("**/api/order-centers/lines/*/operations", (route) => {
    const lineId = new URL(route.request().url()).pathname.split("/").at(-2);
    return route.fulfill({
      json: operations[state.records.findIndex((record) => record.line.id === lineId)],
    });
  });
  let fail = true;
  const writes: Array<Record<string, unknown>> = [];
  await page.route("**/api/order-centers/production/*/milestones", (route) => {
    writes.push(route.request().postDataJSON());
    if (fail) {
      fail = false;
      return route.fulfill({ status: 409, json: { message: "Synthetic production conflict" } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/production?q=SYNTHETIC");
  await page.getByRole("button", { name: "连续处理", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "生产中心 · 连续处理" });
  const reference = drawer.getByLabel("凭证 / 工厂记录编号", { exact: true });
  await reference.fill("FACTORY_RECORD_73");
  await drawer.getByLabel("发生时间", { exact: true }).fill("2026-09-14T15:00");
  page.once("dialog", (dialog) => dialog.dismiss());
  await drawer.getByRole("button", { name: "下一单", exact: true }).click();
  await expect(reference).toHaveValue("FACTORY_RECORD_73");
  await drawer.getByRole("checkbox", { name: "本次操作保存成功后处理下一单" }).check();
  await drawer.getByRole("button", { name: "记录已发送工厂", exact: true }).click();
  await expect(drawer.getByRole("alert")).toContainText("Synthetic production conflict");
  await expect(reference).toHaveValue("FACTORY_RECORD_73");
  await drawer.getByRole("button", { name: "记录已发送工厂", exact: true }).click();
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-2" })).toBeVisible();
  expect(writes[0].externalEventId).toBe(writes[1].externalEventId);
  await expect(drawer.getByLabel("凭证 / 工厂记录编号", { exact: true })).toHaveValue("");
});

test("production saving one form preserves another unsaved form", async ({ page }) => {
  const state = await fixture(page, 2);
  state.records.forEach((record) => {
    record.line.preparation = "pushed";
    record.line.artwork = "approved";
  });
  await page.route("**/api/order-centers/lines/*/operations", (route) =>
    route.fulfill({ json: { production: [], shipments: [], cases: [] } }),
  );
  await page.route("**/api/order-centers/quality-standards", (route) =>
    route.fulfill({ json: {} }),
  );
  await page.goto(`/production?line=${state.records[0].line.id}`);
  const drawer = page.getByRole("dialog", { name: "生产中心 · 连续处理" });
  await drawer.getByText("维护质检标准", { exact: true }).click();
  await drawer.getByLabel("标准名称", { exact: true }).fill("Synthetic QC standard");
  await drawer.getByLabel("检验内容", { exact: true }).fill("Synthetic visual check");
  await drawer.getByLabel("合格分数", { exact: true }).fill("92");
  await drawer.getByLabel("操作原因 / 客户确认依据", { exact: true }).fill("Another unsaved note");
  await drawer.getByRole("button", { name: "保存新标准版本", exact: true }).click();
  await expect(drawer.getByText("质检标准已保存。", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await drawer.getByRole("button", { name: "下一单", exact: true }).click();
  await expect(drawer.getByLabel("操作原因 / 客户确认依据", { exact: true })).toHaveValue(
    "Another unsaved note",
  );
});

async function shipmentsFixture(page: Page) {
  const state = await fixture(page, 2);
  state.records.forEach((record) => {
    record.line.readyQuantity = 1;
  });
  await page.route("**/api/order-centers/lines/*/operations", (route) =>
    route.fulfill({
      json: {
        production: [],
        cases: [],
        shipments: [
          {
            shipment: {
              id: id(600),
              status: "shipped",
              currentVersionNumber: 1,
              approvedVersionNumber: 1,
            },
            versions: [{ id: id(601), versionNumber: 1, shipDate: "2026-09-14T00:00:00Z" }],
            packages: [
              {
                id: id(602),
                shipmentVersionId: id(601),
                trackingNumber: "SYNTHETIC-TRACKING",
                carrierName: "Synthetic carrier",
              },
            ],
            packageLines: [],
            tracking: [],
            writebacks: [],
          },
        ],
      },
    }),
  );
  return state;
}

test("shipments preserves edits in other forms when tracking is saved", async ({ page }) => {
  const state = await shipmentsFixture(page);
  await page.route("**/api/order-centers/shipments/*/tracking", (route) =>
    route.fulfill({ json: {} }),
  );
  await page.goto(`/shipments?line=${state.records[0].line.id}`);
  const drawer = page.getByRole("dialog", { name: "发货中心 · 连续处理" });
  await drawer.getByText("新建包裹", { exact: true }).click();
  await drawer.getByLabel("包裹编号", { exact: true }).fill("UNSAVED-PACKAGE");
  await drawer.getByLabel("物流事件编号", { exact: true }).fill("TRACKING-EVENT");
  await drawer.getByLabel("发生时间", { exact: true }).fill("2026-09-14T15:00");
  await drawer.getByRole("checkbox", { name: "本次操作保存成功后处理下一单" }).check();
  await drawer.getByRole("button", { name: "记录物流进度", exact: true }).click();
  await expect(drawer.getByText("物流进度已记录。", { exact: true })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-1" })).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await drawer.getByRole("button", { name: "下一单", exact: true }).click();
  await expect(drawer.getByLabel("包裹编号", { exact: true })).toHaveValue("UNSAVED-PACKAGE");
});

test("shipments tracking failure keeps input and retry can finish the queue", async ({ page }) => {
  const state = await shipmentsFixture(page);
  let fail = true;
  await page.route("**/api/order-centers/shipments/*/tracking", (route) => {
    if (fail) {
      fail = false;
      return route.fulfill({ status: 409, json: { message: "Synthetic tracking conflict" } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(`/shipments?q=SYNTHETIC&line=${state.records[1].line.id}`);
  const drawer = page.getByRole("dialog", { name: "发货中心 · 连续处理" });
  await drawer.getByLabel("物流事件编号", { exact: true }).fill("TRACKING-RETRY");
  await drawer.getByLabel("发生时间", { exact: true }).fill("2026-09-14T15:00");
  await drawer.getByRole("checkbox", { name: "本次操作保存成功后返回列表" }).check();
  await drawer.getByRole("button", { name: "记录物流进度", exact: true }).click();
  await expect(drawer.getByRole("alert")).toContainText("Synthetic tracking conflict");
  await expect(drawer.getByLabel("物流事件编号", { exact: true })).toHaveValue("TRACKING-RETRY");
  await drawer.getByRole("button", { name: "记录物流进度", exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByLabel("搜索订单", { exact: true })).toHaveValue("SYNTHETIC");
});

test("after-sales preserves failed registration and continues after success", async ({ page }) => {
  const state = await fixture(page, 2);
  await page.route("**/api/order-centers/lines/*/operations", (route) =>
    route.fulfill({ json: { production: [], shipments: [], cases: [] } }),
  );
  let fail = true;
  await page.route("**/api/order-centers/lines/*/cases", (route) => {
    if (fail) {
      fail = false;
      return route.fulfill({ status: 409, json: { message: "Synthetic case conflict" } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(`/after-sales?line=${state.records[0].line.id}`);
  const drawer = page.getByRole("dialog", { name: "售后中心 · 连续处理" });
  await drawer.getByLabel("原因分类", { exact: true }).fill("SYNTHETIC_DAMAGE");
  await drawer.getByLabel("问题说明", { exact: true }).fill("Synthetic case description");
  await drawer.getByRole("checkbox", { name: "本次操作保存成功后处理下一单" }).check();
  await drawer.getByRole("button", { name: "登记售后", exact: true }).click();
  await expect(drawer.getByRole("alert")).toContainText("Synthetic case conflict");
  await expect(drawer.getByLabel("问题说明", { exact: true })).toHaveValue(
    "Synthetic case description",
  );
  await drawer.getByRole("button", { name: "登记售后", exact: true }).click();
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-2" })).toBeVisible();
  await expect(drawer.getByLabel("问题说明", { exact: true })).toHaveValue("");
});

test("after-sales protects unsaved communication before switching", async ({ page }) => {
  const state = await fixture(page, 2);
  await page.route("**/api/order-centers/lines/*/operations", (route) =>
    route.fulfill({
      json: {
        production: [],
        shipments: [],
        cases: [
          {
            case: {
              id: id(700),
              type: "customer_contact",
              status: "open",
              reasonCode: "SYNTHETIC",
              currentDecisionVersion: 0,
              createdAt: "2026-09-14T00:00:00Z",
              summary: "Synthetic customer contact",
            },
            contacts: [],
            decisions: [],
          },
        ],
      },
    }),
  );
  await page.goto(`/after-sales?line=${state.records[0].line.id}`);
  const drawer = page.getByRole("dialog", { name: "售后中心 · 连续处理" });
  await drawer.getByText("登记已发生的沟通", { exact: true }).click();
  await drawer.getByLabel("沟通内容", { exact: true }).fill("Synthetic unsaved communication");
  page.once("dialog", (dialog) => dialog.dismiss());
  await drawer.getByRole("button", { name: "返回售后中心", exact: true }).click();
  await expect(drawer.getByLabel("沟通内容", { exact: true })).toHaveValue(
    "Synthetic unsaved communication",
  );
});

test("order journey returns to its original filters and stable queue", async ({ page }) => {
  const state = await fixture(page, 3);
  await page.goto("/orders?q=SYNTHETIC&preparation=pending_review");
  await page.getByRole("button", { name: "连续审单", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "连续审单" })).toBeVisible();
  const source = page.url();
  state.records[0].line.preparation = "ready_to_push";
  await page
    .getByRole("navigation", { name: "此订单各环节" })
    .getByRole("button", { name: /^制图：/ })
    .click();
  await expect(page.getByRole("dialog", { name: "制图中心 · 连续处理" })).toBeVisible();
  await expect(page).toHaveURL(/\/orders\?/);
  await page.getByRole("navigation", { name: "此订单各环节" }).getByRole("button", { name: /^审单：/ }).click();
  await expect(page).toHaveURL(source);
  const drawer = page.getByRole("dialog", { name: "连续审单" });
  await expect(drawer.getByText("本页 1 / 3", { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "下一单", exact: true }).click();
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-2" })).toBeVisible();
});

test("AI settings returns to the current order queue", async ({ page }) => {
  await fixture(page, 2);
  // Hold only the read transport: visiting settings must not trap the operator,
  // and this navigation test must never read or write live model configuration.
  let releaseConfiguration!: () => void;
  const pendingConfiguration = new Promise<void>((resolve) => {
    releaseConfiguration = resolve;
  });
  let reading = false;
  await page.route("**/api/creative-studio/configuration", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ operation: "configuration.get" });
    reading = true;
    await pendingConfiguration;
    await route
      .fulfill({
        json: {
          channels: [],
          analysisModels: [],
          defaults: { image: null, video: null, text: null, analysis: null },
          defaultsRevision: 0,
        },
      })
      .catch(() => {});
  });
  await page.goto("/orders?q=SYNTHETIC");
  await page.getByRole("button", { name: "连续审单", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "连续审单" })).toBeVisible();
  const source = page.url();
  await page.getByRole("link", { name: "前往 AI 模型配置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "AI 模型配置", exact: true })).toBeVisible();
  try {
    await expect.poll(() => reading).toBe(true);
    await page.getByRole("link", { name: "返回原任务", exact: true }).click();
    await expect(page).toHaveURL(source);
  } finally {
    releaseConfiguration();
  }
  await expect(
    page.getByRole("dialog", { name: "连续审单" }).getByText("本页 1 / 2", { exact: true }),
  ).toBeVisible();
});
