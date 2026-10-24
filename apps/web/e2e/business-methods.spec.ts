import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { AgentMethodRow, AgentMethodWorkspace } from "@yummyai/contracts/harness/methods";
import type { AssistTaskBasis } from "@yummyai/contracts/ai/task-workspace";
import type { AssistView } from "@yummyai/contracts/ai/assist";
import type {
  AmazonReportBatchView,
  AmazonReportWorkspaceView,
  MarketplaceAccountView,
} from "@yummyai/contracts";
import type { OrderWorkDetail } from "@yummyai/contracts/order/workspace";
import { Permission } from "../../../packages/authz/src/index";
import { apiFetch } from "../src/server-api";
import { centerApi } from "./order-centers-fixture";
import { knowledgeGovernanceFixture } from "./knowledge-governance-fixture";
import { salesLaunchFixture } from "./sales-plan-launch-fixture";

test.setTimeout(180000);
// These four stages share one business journey and its immutable task IDs.
test.describe.configure({ mode: "serial" });
let model: Awaited<ReturnType<typeof knowledgeGovernanceFixture>> | undefined;
let catalog: Awaited<ReturnType<typeof salesLaunchFixture>> | undefined;
let lineId: string, listingId: string, completedOrder: AssistView;
let beforeResponse: (() => Promise<void>) | undefined;
const captured: Record<string, unknown>[] = [];
const output = {
  summary: "Synthetic governed business review",
  findings: [],
  directions: [],
  matches: [],
  missingInformation: ["Keep the original business facts for operator review"],
};
const key = (kind: string) => `yummyai.assist.${kind}.review`;
async function method(kind: string) {
  return (await centerApi<AgentMethodWorkspace>("agent-methods/workspace")).methods.find(
    (row) => row.methodKey === key(kind),
  )!;
}
async function action(kind: string, operation: "submit" | "publish" | "disable") {
  const row = await method(kind);
  await centerApi(`agent-methods/${row.id}/${operation}`, {
    expectedRevision: row.revision,
    version: operation === "disable" ? row.activeVersion : row.latestVersion,
    ...(operation === "publish" ? { reviewedChecksum: row.latest.checksum } : {}),
    reason: "Synthetic business method review",
    requestId: randomUUID(),
  });
}
async function publish(kind: string, notes: string): Promise<AgentMethodRow> {
  const row = await method(kind);
  await centerApi("agent-methods/save", {
    methodKey: key(kind),
    expectedRevision: row?.revision ?? 0,
    notes,
    knowledgeVersionIds: [],
    reason: "Synthetic business method",
    requestId: randomUUID(),
  });
  await action(kind, "submit");
  await action(kind, "publish");
  return method(kind);
}
async function basis(
  kind: "order_review" | "sku_package",
  taskGoal = "Synthetic private order goal",
) {
  return centerApi<AssistTaskBasis>("ai-assists/task-basis", {
    kind,
    targetId: kind === "order_review" ? lineId : listingId,
    taskGoal,
  });
}
async function create(value: AssistTaskBasis) {
  return centerApi<AssistView>("ai-assists/runs", {
    ...value.input,
    modelId: model!.modelId,
    requestId: randomUUID(),
  });
}
async function run(id: string) {
  await model!.analyze(id, output);
  return centerApi<AssistView>(`ai-assists/runs/${id}`);
}

test.beforeAll(async () => {
  model = await knowledgeGovernanceFixture("business-methods", {
    onModelRequest: (request) => captured.push(request),
    beforeModelResponse: async () => {
      await beforeResponse?.();
    },
  });
  catalog = await salesLaunchFixture();
  listingId = catalog.ids.listings[0]!;
  const account = await centerApi<MarketplaceAccountView>("marketplace-accounts", {
    platform: "amazon",
    displayName: "Synthetic method business shop",
    region: "NA",
    authorizationMode: "amazon_private",
    marketplaceIds: ["ATVPDKIKX0DER"],
    requestedScopes: [],
  });
  const batch = await centerApi<AmazonReportBatchView>("orders/reports/import", {
    accountId: account.id,
    marketplaceId: "ATVPDKIKX0DER",
    fileName: "synthetic-method-order.txt",
    content: `order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\nMETHOD-${randomUUID()}\tITEM-1\t${new Date().toISOString()}\tSYNTHETIC-METHOD-ORDER\tSynthetic method order\t2\tUSD\t40.00`,
  });
  lineId = (
    await centerApi<AmazonReportWorkspaceView>(`orders/reports/workspace?batchId=${batch.id}`)
  ).lines[0]!.orderLineId;
  await publish("order_review", "Synthetic order method v1; do not change customer fields");
  await publish("sku_package", "Synthetic SKU method v1; do not publish or approve the listing");
});
test.afterAll(async () => {
  try {
    await model?.close();
  } finally {
    await catalog?.close();
  }
});

test("real order and SKU tasks retain reviewed v1 after v2 and reject an outdated inspected basis", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const originalOrder = await centerApi<OrderWorkDetail>(`order-centers/lines/${lineId}`),
    originalListing = await centerApi<{ version: { id: string } }>(`listings/${listingId}`);
  const orderBasis = await basis("order_review"),
    skuBasis = await basis("sku_package");
  expect(orderBasis.methodSelection).toMatchObject({ mode: "published", version: 1 });
  expect(skuBasis.methodSelection).toMatchObject({ mode: "published", version: 1 });
  await page.goto("/ai-tasks");
  await page.getByLabel("要完成的任务", { exact: true }).selectOption("order_review");
  await page.getByLabel("本次业务对象").selectOption(lineId);
  await page.getByLabel("分析重点（可选）", { exact: true }).fill("Synthetic private order goal");
  await page.getByRole("button", { name: "读取本次依据", exact: true }).click();
  await expect(page.getByRole("region", { name: "计划采用的方法" })).toContainText("团队方法 v1");
  await page.getByLabel("图文模型").selectOption(model!.modelId);
  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/ai-assists/runs",
  );
  await page.getByRole("button", { name: "开始分析", exact: true }).click();
  const order = (await (await submitted).json()) as AssistView,
    sku = await create(skuBasis);
  expect(order.methodSelection).toMatchObject({ mode: "published", version: 1 });
  await publish("order_review", "Synthetic order method v2");
  await publish("sku_package", "Synthetic SKU method v2");
  const outdated = await apiFetch(`${process.env.API_BASE_URL}/v1/ai-assists/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...orderBasis.input, modelId: model!.modelId, requestId: randomUUID() }),
  });
  expect(outdated.status).toBe(409);
  expect(model!.modelCalls()).toBe(0);
  completedOrder = await run(order.id);
  const completedSku = await run(sku.id);
  expect(completedOrder.status).toBe("completed");
  expect(completedSku.status).toBe("completed");
  expect(completedOrder.methodSelection).toMatchObject({ mode: "published", version: 1 });
  expect(completedSku.methodSelection).toMatchObject({ mode: "published", version: 1 });
  expect(JSON.stringify(captured[0])).toContain("Synthetic order method v1");
  expect(JSON.stringify(captured[0])).not.toContain("Synthetic order method v2");
  expect(JSON.stringify(captured[1])).toContain("Synthetic SKU method v1");
  for (const request of captured) {
    expect(request.tools).toBeUndefined();
    const messages = request.messages as Array<{ role: string; content: unknown }>;
    expect(JSON.stringify(messages.filter((message) => message.role === "system"))).not.toContain(
      "Synthetic order method",
    );
    expect(JSON.stringify(messages.filter((message) => message.role === "system"))).not.toContain(
      "Synthetic SKU method",
    );
  }
  expect(model!.modelCalls()).toBe(2);
  const currentOrder = await centerApi<OrderWorkDetail>(`order-centers/lines/${lineId}`);
  expect(currentOrder.draft).toEqual(originalOrder.draft);
  expect(currentOrder.line.revision).toBe(originalOrder.line.revision);
  expect((await centerApi<{ version: { id: string } }>(`listings/${listingId}`)).version.id).toBe(
    originalListing.version.id,
  );
  expect((await basis("order_review")).methodSelection).toMatchObject({
    mode: "published",
    version: 2,
  });
  expect((await basis("sku_package")).methodSelection).toMatchObject({
    mode: "published",
    version: 2,
  });
  for (const task of [completedOrder, completedSku]) {
    await page.goto(`/ai-tasks?run=${task.id}`);
    const evidence = page.getByRole("region", { name: "本次固定的方法" });
    await expect(evidence).toContainText("团队方法 v1");
    await expect(evidence.getByRole("link", { name: "查看此版本" })).toHaveAttribute(
      "href",
      `/knowledge/methods?method=${key(task.kind)}&version=1`,
    );
    const opened = page.waitForEvent("popup");
    await evidence.getByRole("link", { name: "查看此版本" }).click();
    const history = await opened;
    await expect(history.getByRole("region", { name: "方法版本记录" })).toContainText(
      task.kind === "order_review" ? "Synthetic order method v1" : "Synthetic SKU method v1",
    );
    await history.close();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      await evidence.scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      await page.screenshot({ path: info.outputPath(`${task.kind}-method-${width}.png`) });
    }
  }
  expect(errors).toEqual([]);
});

test("order method withdrawal stops a queued real order task without purchasing another response", async () => {
  const task = await create(await basis("order_review")),
    calls = model!.modelCalls();
  await action("order_review", "disable");
  const failed = await run(task.id);
  expect(failed.status).toBe("failed");
  expect(failed.result).toBeNull();
  expect(failed.budgetState).toBe("released");
  expect(failed.costUsd).toBeNull();
  expect(model!.modelCalls()).toBe(calls);
});

test("withdrawing a SKU method in flight preserves the original response cost and rejects adoption", async () => {
  const task = await create(await basis("sku_package")),
    calls = model!.modelCalls();
  beforeResponse = () => action("sku_package", "disable");
  try {
    const failed = await run(task.id);
    expect(failed.status).toBe("failed");
    expect(failed.result).toBeNull();
    expect(failed.costUsd).toBeGreaterThan(0);
    expect(failed.budgetState).toBe("committed");
    expect(failed.invocations?.[0]?.boundary).toBe("received");
    expect(model!.modelCalls()).toBe(calls + 1);
  } finally {
    beforeResponse = undefined;
  }
});

test("completed governed business tasks clear their private goals and method links after read permission is revoked", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/ai-tasks?run=${completedOrder.id}`);
  await expect(page.getByRole("region", { name: "本次固定的方法" })).toContainText("团队方法 v1");
  let releaseLate = () => {};
  let markFetched = () => {};
  let markDrained = () => {};
  const fetched = new Promise<void>((resolve) => {
      markFetched = resolve;
    }),
    released = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
  const held = new Set<string>(),
    writes: string[] = [];
  let completedHeld = 0;
  const drained = new Promise<void>((resolve) => {
    markDrained = resolve;
  });
  const calls = model!.modelCalls();
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/ai-assists/runs")
      writes.push(request.url());
  });
  await page.route("**/api/ai-assists/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const type = pathname.endsWith(`/runs/${completedOrder.id}`)
      ? "run"
      : pathname.endsWith("/task-workspace")
        ? "workspace"
        : null;
    if (!type || route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const hold = response.status() === 200 && !held.has(type);
    if (hold) {
      held.add(type);
      if (held.size === 2) markFetched();
      await released;
    }
    await route.fulfill({ response }).catch(() => {
      /* An obsolete browser read may be aborted. */
    });
    if (hold && ++completedHeld === 2) markDrained();
  });
  try {
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await fetched;
    await model!.setPermissions(
      Object.values(Permission).filter((value) => value !== Permission.WorkflowRead),
    );
    expect((await page.request.get(`/api/ai-assists/runs/${completedOrder.id}`)).status()).toBe(
      403,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("region", { name: "本次固定的方法" })).toHaveCount(0);
    await expect(page.getByText("Synthetic private order goal", { exact: true })).toHaveCount(0);
    releaseLate();
    await drained;
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await expect(page.getByRole("region", { name: "本次固定的方法" })).toHaveCount(0);
    await expect(page.getByText("Synthetic private order goal", { exact: true })).toHaveCount(0);
    expect(model!.modelCalls()).toBe(calls);
    expect(writes).toEqual([]);
    await expect(page.getByRole("heading", { name: "AI 任务工作台", exact: true })).toBeVisible();
    await expect(page.locator(".at-detail").getByRole("alert")).toContainText("没有这项分析权限");
    expect(errors).toEqual([]);
  } finally {
    releaseLate();
    await model!.setPermissions(Object.values(Permission));
  }
});
