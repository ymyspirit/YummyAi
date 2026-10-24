import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { FactoryCapacityPoolViewSchema, FactoryCapacityWorkspaceSchema, ProductionCapacityViewSchema } from "@yummyai/contracts/suppliers/factory-capacity";
import { connectDatabase, roles, withTenant } from "@yummyai/database";
import { eq } from "drizzle-orm";
import { actors, identityControl, loginErp, scopedErpRole } from "./erp-identity-fixture";
import { centerApi } from "./order-centers-fixture";
import { createFactoryFixture } from "./factory-directory-fixture";
import { createCapacityFixture, fillProductionCapacity } from "./factory-capacity-fixture";
import { prepareNativeProduction } from "./native-production-fixture";
import { syntheticFactoryCapacityProfile } from "../../../tools/testing/factory-capacity-fixtures";
import { syntheticSupplierProfile } from "../../../tools/testing/factory-fixtures";

const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid"), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_FACTORY_CAPACITY_ISOLATED !== "1" || process.env.WEB_AUTH_MODE !== "personal" ||
  !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`) throw new Error("Factory capacity browser requires its exact personal disposable runner");
test.setTimeout(180_000);
const read = Permission.OrderRead, write = Permission.OrderWrite;
const apiBase = process.env.API_BASE_URL!.replace(/\/$/, "");
async function personal(page: Page, path: string, body?: unknown, account: "operator" | "readonly" = "operator") {
  const { access_token: token } = await identityControl("token", { account });
  return fetch(`${apiBase}/v1/${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${token}`, origin: new URL(page.url()).origin, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
}
async function site() {
  const suffix = createEntityId(), supplier = await centerApi<{ id: string }>("sourcing/suppliers", { name: `Synthetic capacity supplier ${suffix}`, kind: "manual", regionCode: "US", settlementCurrency: "USD", profile: syntheticSupplierProfile });
  const factory = await createFactoryFixture(supplier.id, "rectangular_print", `Synthetic capacity site ${suffix}`);
  return { ...factory, supplierId: supplier.id, path: `/suppliers/${supplier.id}/factories/${factory.factory.id}` };
}
async function click(value: Locator) { await value.scrollIntoViewIfNeeded(); await expect(value).toBeInViewport(); await expect(value).toBeEnabled(); await value.click(); }
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const panel of await page.locator('.fc-workspace,dialog[open]').all()) expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}
async function role() {
  const actor = actors().readonly, database = connectDatabase();
  try {
    const [value] = await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" }, tx =>
      tx.select({ permissions: roles.permissions, dataScope: roles.dataScope }).from(roles).where(eq(roles.id, actor.roleId)));
    if (!value || !["self", "team", "tenant"].includes(value.dataScope)) throw new Error("Synthetic capacity role missing");
    return { permissions: value.permissions, dataScope: value.dataScope as "self" | "team" | "tenant" };
  } finally { await database.client.end(); }
}
async function setRole(value: Awaited<ReturnType<typeof role>>) {
  const actor = actors().readonly, database = connectDatabase();
  try { await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" }, tx => tx.update(roles).set(value).where(eq(roles.id, actor.roleId))); }
  finally { await database.client.end(); }
}

test("personal operators explicitly confirm a finite calendar, revise it and read both immutable pool versions", async ({ page }, info) => {
  const value = await site(), name = `Synthetic shared pool ${createEntityId()}`;
  await page.setViewportSize({ width: 1440, height: 1000 }); await loginErp(page, "operator", value.path);
  const workspace = page.getByRole("region", { name: "工厂日历与共享产能", exact: true });
  await expect(workspace).toHaveAttribute("aria-busy", "false"); await expect(workspace).toContainText("尚无可核对的共享产能池");
  await click(workspace.getByRole("button", { name: "新增共享产能池", exact: true }));
  const form = page.getByRole("form", { name: "新增共享产能池", exact: true });
  await form.getByLabel("产能池名称", { exact: true }).fill(name); await form.getByRole("combobox", { name: "状态", exact: true }).selectOption("active");
  await form.getByLabel("固定资源池编码", { exact: true }).fill(`SYNTHETIC-${randomUUID()}`);
  await form.getByLabel("每日产能额度", { exact: true }).fill("10");
  for (const day of ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]) {
    await click(form.getByRole("button", { name: `增加${day}工作区间`, exact: true }));
    await form.getByLabel(`${day}区间1开始`, { exact: true }).fill("00:00"); await form.getByLabel(`${day}区间1结束`, { exact: true }).fill("24:00");
  }
  await click(form.getByRole("button", { name: "增加能力绑定", exact: true }));
  await form.getByLabel("固定能力版本1", { exact: true }).selectOption(value.capability.versionId);
  await form.getByLabel("每件占用单位1", { exact: true }).fill("1");
  await form.getByLabel("实际产能依据", { exact: true }).fill("Synthetic finite daily capacity checked for this disposable fixture only");
  await click(form.getByRole("button", { name: "保存产能池版本", exact: true }));
  await expect(page.getByRole("region", { name: "产能池版本已登记", exact: true })).toContainText("V1");
  await click(page.getByRole("button", { name: "确认资源池版本并返回", exact: true }));
  await expect(workspace).toContainText(name); await expect(workspace.getByRole("region", { name: "所选资源池当地日历", exact: true })).toContainText("原总预留 0");
  await click(workspace.getByRole("button", { name: "修订产能池", exact: true }));
  const revision = page.getByRole("form", { name: "修订共享产能池", exact: true });
  await expect(revision.getByLabel("固定产能单位", { exact: true })).toHaveCount(0); await revision.getByLabel("每日产能额度", { exact: true }).fill("8");
  await click(revision.getByRole("button", { name: "保存产能池版本", exact: true }));
  await expect(page.getByRole("region", { name: "产能池版本已登记", exact: true })).toContainText("V2");
  await click(page.getByRole("button", { name: "确认资源池版本并返回", exact: true }));
  await click(workspace.getByRole("button", { name: "读取此池历史", exact: true }));
  const history = workspace.getByRole("region", { name: "共享产能池版本历史", exact: true });
  const versionSummaries = history.locator(":scope > details > summary");
  await expect(versionSummaries).toHaveCount(2); await versionSummaries.filter({ hasText: "V1" }).click();
  await expect(history).toContainText("每日额度 10"); await versionSummaries.filter({ hasText: "V2" }).click(); await expect(history).toContainText("每日额度 8");
  await noOverflow(page); await workspace.screenshot({ path: info.outputPath("factory-capacity-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page); await workspace.screenshot({ path: info.outputPath("factory-capacity-mobile.png") });
  const response = await personal(page, `sourcing/factories/${value.factory.id}/capacity?days=1`); expect(response.status).toBe(200);
  const saved = FactoryCapacityWorkspaceSchema.parse(await response.json()); expect(saved.pools).toHaveLength(1); expect(saved.pools[0]!.versionNumber).toBe(2);
  expect(saved.calendar[0]).toMatchObject({ allocatedUnits: 0, capacityUnits: 8, availableUnits: 8 });
});

test("personal native production previews real local capacity and preserves reservation and final cancellation receipts", async ({ page }, info) => {
  const value = await prepareNativeProduction(); await page.setViewportSize({ width: 1440, height: 1000 });
  await loginErp(page, "operator", `/production?view=native&line=${value.lineId}`);
  const form = page.getByRole("form", { name: "建立直接生产安排", exact: true });
  await form.getByLabel("完整产品规格", { exact: true }).selectOption(value.specificationVersionId);
  await form.getByLabel("已审核设计", { exact: true }).selectOption(value.designVersionId);
  await form.getByLabel("已批准采购来源", { exact: true }).selectOption(`${value.routingDecisionId}:${value.purchaseOrderVersionId}`);
  await form.getByLabel("本次下达数量", { exact: true }).fill("3");
  await form.getByLabel("制造版本", { exact: true }).selectOption(value.manufacturing.versionId); await form.getByRole("checkbox", { name: /已核对原规格/ }).check();
  await form.getByLabel("生产工厂", { exact: true }).selectOption(value.capabilityVersionId);
  await form.getByLabel("工厂当地预计完成时间", { exact: true }).fill(value.capacity.dueLocal);
  await form.getByLabel("本次产品及设计确认依据", { exact: true }).fill("Synthetic exact rectangular design and physical unit reviewed");
  await form.getByLabel("本次生产说明", { exact: true }).fill("Synthetic capacity-backed internal task No supplier contact");
  await form.getByRole("checkbox", { name: /已核对完整产品规格/ }).check();
  await expect(form.getByRole("button", { name: "建立内部生产安排", exact: true })).toBeDisabled();
  await fillProductionCapacity(form, value.capacity);
  const preview = form.getByRole("region", { name: "本批产能核对结果", exact: true }); await expect(preview).toContainText("本批需要 3");
  const before = await personal(page, `sourcing/factories/${value.factoryId}/capacity?days=1`); expect(before.status).toBe(200);
  expect(FactoryCapacityWorkspaceSchema.parse(await before.json()).calendar[0]!.allocatedUnits).toBe(0);
  await click(form.getByRole("button", { name: "建立内部生产安排", exact: true }));
  const recovery = page.getByRole("region", { name: "待确认生产提交", exact: true }); await expect(recovery).toContainText("生产安排已建立");
  const actual = await centerApi<{ id: string; projectionVersion: number }[]>(`production/orders?orderId=${value.orderId}`);
  expect(actual).toHaveLength(1); const id = actual[0]!.id;
  let capacity = ProductionCapacityViewSchema.parse(await (await personal(page, `sourcing/production-orders/${id}/capacity`)).json());
  expect(capacity.reservations).toHaveLength(1); expect(capacity.reservations[0]).toMatchObject({ totalUnits: 3, committedUnits: 0, releasedUnits: 0 });
  for (const [index, type] of ["cancel_requested", "cancelled"].entries()) {
    const current = await centerApi<{ productionOrder: { projectionVersion: number } }>(`production/orders/${id}`);
    const response = await personal(page, `production/orders/${id}/milestones`, { type, expectedProjectionVersion: current.productionOrder.projectionVersion,
      externalEventId: randomUUID(), occurredAt: new Date().toISOString(), evidence: { code: "SYNTHETIC_CAPACITY_CANCELLATION", note: null, assetIds: [] } });
    expect(response.status).toBe(201); capacity = ProductionCapacityViewSchema.parse(await (await personal(page, `sourcing/production-orders/${id}/capacity`)).json());
    expect(capacity.reservations[0]).toMatchObject({ totalUnits: 3, releasedUnits: index === 0 ? 0 : 3, committedUnits: 0 });
  }
  await click(recovery.getByRole("button", { name: "已核对本次结果", exact: true })); await page.reload();
  const receipt = page.getByRole("region", { name: "原生产产能预留与释放", exact: true }); await expect(receipt).toContainText("原预留 3 · 已承诺 0 · 已释放 3");
  await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page); await receipt.screenshot({ path: info.outputPath("factory-capacity-production-receipt-mobile.png") });
});

test("personal mixed scopes cannot borrow tenant Read for capacity writes and a narrowed pending history clears private data", async ({ page }) => {
  const original = await role(), value = await site(), capacity = await createCapacityFixture(value.factory, [value.capability], 10);
  let extra: Awaited<ReturnType<typeof scopedErpRole>> | undefined, release: (() => void) | undefined, completed: Promise<void> | undefined;
  const pattern = `**/api/factory-capacity/factories/${value.factory.id}/capacity-pools/${capacity.pool.id}/history`;
  try {
    await setRole({ permissions: [...original.permissions.filter(item => item !== read && item !== write), write], dataScope: "self" }); extra = await scopedErpRole([read], "tenant");
    await loginErp(page, "readonly", value.path);
    const workspace = page.getByRole("region", { name: "工厂日历与共享产能", exact: true }); await expect(workspace).toContainText(capacity.pool.profile.name);
    await expect(workspace.getByRole("button", { name: "新增共享产能池", exact: true })).toHaveCount(0);
    const input = { factoryVersionId: value.factory.versionId, code: `SYNTHETIC-${randomUUID()}`, timeZone: value.factory.profile.timeZone!, unit: "each",
      profile: syntheticFactoryCapacityProfile([{ capabilityVersionId: value.capability.versionId, unitsPerItem: 1 }], 2), idempotencyKey: randomUUID() };
    expect((await personal(page, `sourcing/factories/${value.factory.id}/capacity-pools`, input, "readonly")).status).toBe(403);
    const gate = new Promise<void>(resolve => { release = resolve; }); let started = false;
    await page.route(pattern, route => {
      started = true; completed = (async () => { await gate; await route.continue(); })(); return completed;
    });
    await click(workspace.getByRole("button", { name: "读取此池历史", exact: true })); await expect.poll(() => started).toBe(true);
    await extra.remove(); extra = undefined; await setRole({ ...original, permissions: [...original.permissions.filter(item => item !== write), read], dataScope: "self" });
    expect((await personal(page, `sourcing/factories/${value.factory.id}/capacity-pools/${capacity.pool.id}/history`, undefined, "readonly")).status).toBe(403);
    if (!release) throw new Error("Synthetic capacity history gate missing"); release(); await completed;
    await expect(page.getByRole("heading", { name: "工厂详情", exact: true })).toBeVisible();
    await expect(page.getByText(value.factory.profile.name, { exact: true })).toHaveCount(0); await expect(page.getByText(capacity.pool.profile.name, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "共享产能池版本历史", exact: true })).toHaveCount(0);
    await setRole({ ...original, permissions: [...original.permissions.filter(item => item !== read && item !== write), read], dataScope: "self" }); extra = await scopedErpRole([write], "tenant");
    const written = await personal(page, `sourcing/factories/${value.factory.id}/capacity-pools`, input, "readonly"); expect(written.status).toBe(201);
    expect(FactoryCapacityPoolViewSchema.parse(await written.json())).toMatchObject({ factoryId: value.factory.id, versionNumber: 1 });
    expect((await personal(page, `sourcing/factories/${value.factory.id}/capacity`, undefined, "readonly")).status).toBe(403);
  } finally {
    release?.(); try { await completed; } finally { try { await page.unroute(pattern); } finally { try { await extra?.remove(); } finally { await setRole(original); } } }
  }
});
