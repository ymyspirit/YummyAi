import { expect, test, type Locator } from "@playwright/test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import type JSZipType from "../../api/node_modules/jszip";
import type { ProductionDeliveryWorkspace } from "@yummyai/contracts/order/production-delivery";
import { startProductionEditorWorker } from "./production-editor-fixture";
import { prepareDeliveryOrder } from "./production-delivery-fixture";
import { fillProductionCapacity } from "./factory-capacity-fixture";
import { loginErp, changeErpRights } from "./erp-identity-fixture";
import { Permission } from "@yummyai/authz";
import { centerApi } from "./order-centers-fixture";
import type { OrderOperationsView } from "@yummyai/contracts/order/workspace";

const requireFixture = createRequire(new URL("../../api/package.json", import.meta.url));
const JSZip = requireFixture("jszip") as typeof JSZipType;
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
let worker: ChildProcess | undefined;
test.beforeAll(async () => { worker = await startProductionEditorWorker(); });
test.afterAll(() => { worker?.kill(); });

test("personal single-item production splits a SKU across factories and recovers the original committed request", async ({ page }, info) => {
  test.setTimeout(240000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const order = await prepareDeliveryOrder(2, true, { release: false }), lineId = order.lines[0]!;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await loginErp(page, "operator", `/production?q=${order.externalId}&line=${lineId}`);
  const panel = page.locator("details.oc-single-production");
  await panel.locator("summary").click();
  const form = panel.getByRole("form", { name: "安排本商品生产", exact: true });
  await expect(panel).toContainText("还可安排 2");
  await form.getByLabel("本次商品数量", { exact: true }).fill("1");
  const manufacturing = form.getByRole("group", { name: "本次制造依据", exact: true });
  await manufacturing.getByLabel("制造版本", { exact: true }).selectOption(order.manufacturing.versionId);
  await manufacturing.getByRole("checkbox").check();
  const factory = form.getByLabel("生产工厂", { exact: true });
  const chooseFactory = async (name: string) => {
    await expect(factory).toBeEnabled();
    const option = factory.getByRole("option", { name: new RegExp(`^${name} ·`) });
    await expect(option).toHaveCount(1); await factory.selectOption((await option.getAttribute("value"))!);
  };
  await chooseFactory(order.factoryName);
  await form.getByLabel("工厂当地预计完成", { exact: true }).fill(order.capacity.dueLocal);
  await form.getByLabel("本次生产说明", { exact: true }).fill("Synthetic explicit single-item split production");
  await fillProductionCapacity(form, order.capacity);
  await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath("single-production-form-desktop.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("single-production-form-mobile.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const payloads: Record<string, unknown>[] = []; let loseResponse = true;
  await page.route("**/api/order-centers/production-commands", async route => {
    if (route.request().method() === "POST") payloads.push(route.request().postDataJSON().input);
    await route.continue();
  });
  await page.route("**/api/order-centers/production-commands/*/execute", async route => {
    expect(route.request().postDataJSON()).toEqual({});
    if (loseResponse) { loseResponse = false; const response = await route.fetch(); expect(response.ok()).toBe(true); await route.abort("failed"); }
    else await route.continue();
  });
  await expect(form.getByRole("button", { name: "安排本商品生产", exact: true })).toBeEnabled();
  await form.getByRole("button", { name: "安排本商品生产", exact: true }).click();
  const recovery = page.getByRole("region", { name: "待确认生产提交", exact: true });
  await expect(recovery).toContainText("生产安排已建立");
  page.once("dialog", dialog => dialog.accept()); await page.reload();
  await panel.locator("summary").click();
  await expect(recovery).toContainText("生产安排已建立");
  await recovery.getByRole("button", { name: "已核对本次结果", exact: true }).click();
  const operations = () => centerApi<OrderOperationsView>(`order-centers/lines/${lineId}/operations`);
  await expect.poll(async () => (await operations()).production.length).toBe(1);
  expect(payloads).toHaveLength(1); expect(payloads[0]?.quantity).toBe(1);
  await expect(panel).toContainText("还可安排 1");
  await expect(recovery).toContainText("当前没有待确认的生产提交");
  await expect(form.getByLabel("本次商品数量", { exact: true })).toBeEnabled();
  await expect(factory).toBeEnabled();
  let reloadedReadonly = false;
  const recheckAuthority = async (loaded?: () => void) => {
    const navigation = page.waitForEvent("framenavigated", { predicate: frame => frame === page.mainFrame(), timeout: 20000 });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await navigation; loaded?.();
    await expect(page.getByRole("button", { name: "退出登录", exact: true })).toBeVisible();
    await expect(panel.locator("summary")).toBeVisible();
    if (!(await panel.evaluate(element => (element as HTMLDetailsElement).open))) await panel.locator("summary").click();
  };
  try {
    await changeErpRights("operator", Object.values(Permission).filter(permission => permission !== Permission.OrderWrite));
    const availability = await page.request.get(`/api/order-centers/lines/${lineId}/production-availability`);
    expect(availability.status()).toBe(200); expect((await availability.json()).canRelease).toBe(false);
    await recheckAuthority(() => { reloadedReadonly = true; });
    await expect(panel).toContainText("当前角色可核对生产数量 下达生产需要订单操作权限");
    await expect(form.getByRole("button", { name: "安排本商品生产", exact: true })).toBeDisabled();
    await expect(panel).toContainText("还可安排 1"); expect((await operations()).production).toHaveLength(1);
  } finally {
    await changeErpRights("operator", Object.values(Permission));
    if (reloadedReadonly) await recheckAuthority();
    else await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  }
  await expect(form.getByLabel("本次商品数量", { exact: true })).toBeEnabled();
  await chooseFactory(`${order.factoryName} second`);
  await manufacturing.getByLabel("制造版本", { exact: true }).selectOption(order.manufacturing.versionId);
  await manufacturing.getByRole("checkbox").check();
  const secondCapacity = order.capacities.get(order.factories[1]!.id)!;
  await form.getByLabel("工厂当地预计完成", { exact: true }).fill(secondCapacity.dueLocal);
  await fillProductionCapacity(form, secondCapacity);
  await form.getByRole("button", { name: "安排本商品生产", exact: true }).click();
  await expect.poll(async () => (await operations()).production.length).toBe(2);
  const saved = (await operations()).production;
  expect(new Set(saved.map(record => record.productionOrder.factoryId))).toEqual(new Set(order.factories.map(factory => factory.id)));
  expect(saved.map(record => record.versions.find(version => version.versionNumber === record.productionOrder.currentVersionNumber)?.manufacturing?.quantity)).toEqual([1, 1]);
  expect(payloads).toHaveLength(2); expect(payloads[1]?.idempotencyKey).not.toBe(payloads[0]?.idempotencyKey);
  await expect(panel).toContainText("本商品已全部安排");
  await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath("single-production-split-desktop.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("single-production-split-mobile.png"), animations: "disabled" });
  expect(errors).toEqual([]);
});

async function reply(form: Locator, kind: string) {
  const details = form.locator("xpath=ancestor::details[1]"), summary = details.locator(":scope > summary");
  await expect(summary).toHaveText(/^(登记真实文件提交凭据|可选补充回执与异常处理)$/);
  if (await details.getAttribute("open") === null) await summary.click();
  await expect(form).toBeVisible();
  await form.getByLabel("回执类型", { exact: true }).selectOption(kind);
  await form.getByLabel(kind === "submitted" ? "提交凭证依据" : "回复依据", { exact: true }).fill(`SYNTHETIC-${kind}`);
  await form.getByLabel(kind === "submitted" ? "文件提交说明" : "工厂回复与处理说明", { exact: true }).fill(`Synthetic actual ${kind} of exact file and manufacturing plan`);
  await form.getByRole("checkbox", { name: kind === "submitted" ? "我已核对真实文件提交凭据 文件及制造清单校验值" : "我已核对工厂实际回复、文件及制造清单校验值", exact: true }).check();
  await form.getByRole("button", { name: "登记回执", exact: true }).click();
}

test("personal production fixes manufacturing choices, recovers original whole release and delivers exact V3 files", async ({ page }, info) => {
  test.setTimeout(240000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const order = await prepareDeliveryOrder(2, false, { release: false });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await loginErp(page, "operator", `/production?q=${order.externalId}&line=${order.lines[0]}`);
  const production = page.getByRole("region", { name: "整单生产", exact: true });
  const form = production.getByRole("form", { name: "安排整单生产", exact: true });
  const choices = form.getByRole("group", { name: "本次制造依据", exact: true });
  await expect(choices).toHaveCount(2);
  for (const choice of await choices.all()) {
    await choice.getByLabel("制造版本", { exact: true }).selectOption(order.manufacturing.versionId);
    await choice.getByRole("checkbox").check();
  }
  let failRead = true;
  await page.route("**/api/order-centers/lines/*/manufacturing", async route => {
    if (failRead) { failRead = false; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic transient manufacturing read" }) }); }
    else await route.continue();
  });
  await choices.first().getByRole("button", { name: "重新核对制造依据", exact: true }).click();
  await expect(choices.first().getByRole("alert")).toBeVisible();
  await expect(form.getByRole("button", { name: "安排整单生产（4 件）", exact: true })).toBeDisabled();
  await expect(choices.first().getByLabel("制造版本", { exact: true })).toHaveValue(order.manufacturing.versionId);
  await choices.first().getByRole("button", { name: "重新核对制造依据", exact: true }).click();
  await expect(choices.first().getByRole("alert")).toHaveCount(0);
  await expect(choices.first().getByLabel("制造版本", { exact: true })).toBeEnabled();
  await expect(choices.first().getByLabel("制造版本", { exact: true })).toHaveValue(order.manufacturing.versionId);
  await form.getByLabel("承接工厂").selectOption(order.factoryId);
  await form.getByLabel("整单工厂当地计划完工", { exact: true }).fill(order.capacity.dueLocal);
  await form.getByLabel("整单补充说明（选填）").fill("Synthetic whole manufacturing handoff");
  await fillProductionCapacity(form, order.capacity, 2);
  const requests: unknown[] = []; let loseReply = true;
  await page.route("**/api/order-centers/production-commands", async route => {
    if (route.request().method() !== "POST") return route.continue();
    requests.push(route.request().postDataJSON());
    const response = await route.fetch(); expect(response.status()).toBe(201);
    if (loseReply) { loseReply = false; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic committed response unavailable" }) }); }
    else await route.fulfill({ response });
  });
  await form.getByRole("button", { name: "安排整单生产（4 件）", exact: true }).click();
  const recovery = page.getByRole("region", { name: "待确认生产提交", exact: true });
  await expect(recovery.getByRole("button", { name: "按原确认下达生产", exact: true })).toBeVisible();
  page.once("dialog", dialog => dialog.accept()); await page.reload();
  await expect(recovery).toContainText("Synthetic whole manufacturing handoff");
  await recovery.getByRole("button", { name: "按原确认下达生产", exact: true }).click();
  await expect(recovery).toContainText("生产安排已建立");
  await recovery.getByRole("button", { name: "已核对本次结果", exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(requests).toHaveLength(1);
  await page.locator("summary").filter({ hasText: /^工厂交付与回执/ }).click();
  const panel = page.getByRole("region", { name: "抱枕交付与工厂回执", exact: true });
  const deliveryRequests: unknown[] = []; let loseDeliveryReply = true;
  await page.route("**/api/order-centers/deliveries", async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    deliveryRequests.push(route.request().postDataJSON()); const response = await route.fetch(); expect(response.status()).toBe(201);
    if (loseDeliveryReply) { loseDeliveryReply = false; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic committed delivery response unavailable" }) }); }
    else await route.fulfill({ response });
  });
  await panel.getByRole("button", { name: "生成本单完整交付包（2）", exact: true }).click();
  await panel.getByRole("button", { name: "恢复本次提交结果", exact: true }).click();
  expect(deliveryRequests).toHaveLength(2); expect(deliveryRequests[1]).toEqual(deliveryRequests[0]);
  const summaries = panel.getByRole("region", { name: "本次制造清单", exact: true });
  await expect(summaries).toHaveCount(2);
  await expect(summaries.first()).toContainText("商家供料");
  await expect(summaries.first()).toContainText("工厂执行");
  const downloadPromise = page.waitForEvent("download");
  await panel.getByRole("button", { name: "下载正式交付包", exact: true }).click();
  const download = await downloadPromise;
  const zip = await JSZip.loadAsync(await readFile((await download.path())!));
  const raw = await zip.file("manifest.json")!.async("string"), manifest = JSON.parse(raw);
  expect(manifest.schemaVersion).toBe(3); expect(manifest.items).toHaveLength(2);
  for (const item of manifest.items) {
    expect(item.manufacturing.versionId).toBe(order.manufacturing.versionId);
    expect(hash(await zip.file(item.file.path)!.async("nodebuffer"))).toBe(item.file.checksum);
  }
  expect(await zip.file("制造材料清单.csv")!.async("string")).toContain("FABRIC");
  expect(await zip.file("制造工序清单.csv")!.async("string")).toContain("MAKE");
  for (const row of await panel.getByRole("form", { name: new RegExp(`登记工厂回执 ${order.externalId}`), includeHidden: true }).all()) {
    for (const kind of ["submitted", "received", "accepted"]) { await reply(row, kind); await expect(row.getByLabel("回执类型", { exact: true })).toHaveValue(kind === "submitted" ? "received" : kind === "received" ? "accepted" : "rejected"); }
  }
  const saved = await centerApi<ProductionDeliveryWorkspace>(`order-centers/deliveries?factory=${order.factoryId}`);
  expect(saved.packages).toHaveLength(1); expect(saved.packages[0]!.checksum).toBe(hash(raw));
  expect(saved.packages[0]!.items.every(item => item.status === "accepted" && item.feedback.length === 3)).toBe(true);
  for (const id of order.lines) {
    const detail = await centerApi<{ line: { readyQuantity: number } }>(`order-centers/lines/${id}`);
    expect(detail.line.readyQuantity).toBe(0);
  }
  await summaries.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("operator-manufacturing-delivery-desktop.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await summaries.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("operator-manufacturing-delivery-mobile.png"), animations: "disabled" });
  expect(errors).toEqual([]);
});

test("manufacturing source clears on current product revocation and ignores an earlier successful response", async ({ page }) => {
  test.setTimeout(180000);
  const order = await prepareDeliveryOrder(1, false, { release: false });
  await loginErp(page, "operator", `/production?q=${order.externalId}&line=${order.lines[0]}`);
  const form = page.getByRole("form", { name: "安排整单生产", exact: true });
  const choice = form.getByRole("group", { name: "本次制造依据", exact: true });
  await choice.getByLabel("制造版本", { exact: true }).selectOption(order.manufacturing.versionId);
  await choice.getByRole("checkbox").check();
  let captured!: () => void, release!: () => void, finished!: () => void;
  const ready = new Promise<void>(resolve => { captured = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const complete = new Promise<void>(resolve => { finished = resolve; });
  let intercept = true;
  await page.route("**/api/order-centers/lines/*/manufacturing", async route => {
    if (!intercept) { await route.continue(); return; }
    intercept = false;
    const response = await route.fetch(); expect(response.status()).toBe(200); captured();
    await hold;
    try { await route.fulfill({ response }); } catch { /* The superseded browser request was deliberately aborted. */ }
    finally { finished(); }
  });
  try {
    await choice.getByRole("button", { name: "重新核对制造依据", exact: true }).click(); await ready;
    await changeErpRights("operator", Object.values(Permission).filter(permission => permission !== Permission.ProductRead));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const privateOption = page.locator(`.oc-manufacturing-fields option[value="${order.manufacturing.versionId}"]`);
    await expect(privateOption).toHaveCount(0);
    release(); await complete;
    await expect(privateOption).toHaveCount(0);
  } finally {
    release(); await changeErpRights("operator", Object.values(Permission));
  }
});
