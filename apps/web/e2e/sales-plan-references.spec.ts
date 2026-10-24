import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { connectDatabase, researchItems, withTenant } from "@yummyai/database";
import { actors, changeErpRights, identityControl, loginErp } from "./erp-identity-fixture";
const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(({ page }) => {
  expect(pageErrors.get(page) ?? []).toEqual([]);
});

async function api(path: string, method = "GET", body?: unknown) {
  if (process.env.E2E_ISOLATED_DAILY !== "1") throw Error("Disposable reference browser required");
  const { access_token } = await identityControl("token", { account: "operator" });
  return fetch(`${process.env.API_BASE_URL}/v1/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${access_token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function create(path: string, body: unknown) {
  const r = await api(path, "POST", body);
  expect(r.status, await r.clone().text()).toBe(201);
  return r.json();
}
async function seed(count = 2) {
  const actor = actors().operator,
    db = connectDatabase(),
    ids = Array.from({ length: count }, () => createEntityId()),
    label = `Synthetic preserved source ${randomUUID()}`;
  try {
    const context = {
      tenantId: actor.tenantId,
      userId: actor.userId,
      permissions: Object.values(Permission),
      dataScope: "tenant" as const,
    };
    await withTenant(db.db, context, (tx) =>
      tx.insert(researchItems).values(
        ids.map((id, i) => ({
          id,
          tenantId: actor.tenantId,
          ownerUserId: actor.userId,
          platform: "amazon",
          marketplace: "US",
          normalizedUrl: `https://example.invalid/${id}`,
          latestTitle: i === 0 ? label : `Synthetic candidate ${id}`,
          lastCapturedAt: new Date(1_600_000_000_000 + i * 1000),
        })),
      ),
    );
  } finally {
    await db.client.end();
  }
  const { spu } = await create("product-development/spus", {
    code: `REF-${randomUUID().slice(0, 8)}`,
    name: "Synthetic reference product",
    idempotencyKey: randomUUID(),
  });
  const { plan } = await create("sales-plans", {
    spuId: spu.id,
    fields: {
      name: `Synthetic reference plan ${randomUUID()}`,
      mode: "custom",
      fulfillment: "fbm",
      researchItemIds: [ids[0]],
      positioning: "Synthetic original positioning",
    },
    idempotencyKey: randomUUID(),
  });
  return { plan, ids, label };
}
const name = (page: Page) => page.getByLabel("方案名称", { exact: true });
const notice = (page: Page) => page.getByRole("region", { name: "关联资料核对", exact: true });
async function archive(id: string) {
  const response = await api("research-items/archive", "POST", { itemIds: [id], archived: true });
  expect(response.status).toBe(201);
}
test("archived references stay pinned while choosing another source and change only after explicit removal", async ({
  page,
}, info) => {
  const f = await seed(),
    old = f.ids[0]!,
    next = f.ids[1]!;
  await loginErp(page, "operator", `/sales-plans?plan=${f.plan.id}`);
  await expect(page.getByRole("button", { name: "保存方案", exact: true })).toBeEnabled();
  await archive(old);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(notice(page).getByText(old, { exact: true })).toBeVisible();
  await page.getByText("研究与定位依据", { exact: true }).click();
  await page.getByLabel("关联研究商品", { exact: true }).selectOption(next);
  await expect(notice(page).getByText(old, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存方案", exact: true })).toBeDisabled();
  expect(
    (await (await api(`sales-plans/${f.plan.id}`)).json()).plan.fields.researchItemIds,
  ).toEqual([old]);
  await page.screenshot({ path: info.outputPath("reference-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath("reference-mobile.png"), fullPage: true });
  await notice(page)
    .getByRole("button", { name: `移除研究商品关联 ${old}`, exact: true })
    .click();
  await expect(page.getByRole("button", { name: "保存方案", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "保存方案", exact: true }).click();
  await expect(page.getByText("销售方案已保存", { exact: true })).toBeVisible();
  const detail = await (await api(`sales-plans/${f.plan.id}`)).json();
  expect(detail.plan.fields.researchItemIds).toEqual([next]);
  expect(detail.plan.fields.positioning).toBe("Synthetic original positioning");
});
test("a selected item outside the default 500 is visible and remains unchanged on save", async ({
  page,
}) => {
  const f = await seed(501),
    old = f.ids[0]!;
  expect(
    (await (await api("sales-plans/options")).json()).researchItems.some(
      (r: { id: string }) => r.id === old,
    ),
  ).toBe(false);
  await loginErp(page, "operator", `/sales-plans?plan=${f.plan.id}`);
  await expect(page.getByRole("button", { name: "保存方案", exact: true })).toBeEnabled();
  await page.getByText("研究与定位依据", { exact: true }).click();
  const selected = page
    .getByLabel("关联研究商品", { exact: true })
    .locator(`option[value="${old}"]`);
  await expect(selected).toHaveJSProperty("selected", true);
  await expect(selected).toContainText(f.label);
  await name(page).fill("Synthetic outside-cap preserved");
  await page.getByRole("button", { name: "保存方案", exact: true }).click();
  await expect(page.getByText("销售方案已保存", { exact: true })).toBeVisible();
  expect(
    (await (await api(`sales-plans/${f.plan.id}`)).json()).plan.fields.researchItemIds,
  ).toEqual([old]);
});
test("a temporary reference check failure retains unsaved input and recovers through its read-only retry", async ({
  page,
}) => {
  const f = await seed(1);
  let fail = true;
  await page.route(`**/api/sales-plans/${f.plan.id}/reference-options`, async (route) => {
    if (fail) {
      fail = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "Synthetic transient read failure" }),
      });
    } else await route.continue();
  });
  await loginErp(page, "operator", `/sales-plans?plan=${f.plan.id}`);
  await expect(
    notice(page).getByText("关联资料暂时无法核对 已有输入已保留 请重试核对", { exact: true }),
  ).toBeVisible();
  await name(page).fill("Synthetic preserved during reference outage");
  await expect(page.getByRole("button", { name: "保存方案", exact: true })).toBeDisabled();
  expect((await (await api(`sales-plans/${f.plan.id}`)).json()).plan.revision).toBe(1);
  await notice(page).getByRole("button", { name: "重试核对关联资料", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存方案", exact: true })).toBeEnabled();
  await expect(name(page)).toHaveValue("Synthetic preserved during reference outage");
  await page.getByRole("button", { name: "保存方案", exact: true }).click();
  await expect(page.getByText("销售方案已保存", { exact: true })).toBeVisible();
  expect(
    (await (await api(`sales-plans/${f.plan.id}`)).json()).plan.fields.researchItemIds,
  ).toEqual(f.ids);
});
test("a late reference response for A cannot replace B's current missing reference", async ({
  page,
}) => {
  const a = await seed(1),
    b = await seed(1);
  await archive(b.ids[0]!);
  let release = () => {},
    started = () => {},
    finished = () => {};
  const held = new Promise<void>((r) => (release = r)),
    captured = new Promise<void>((r) => (started = r)),
    delivered = new Promise<void>((r) => (finished = r));
  await page.route(`**/api/sales-plans/${a.plan.id}/reference-options`, async (route) => {
    const response = await route.fetch();
    started();
    await held;
    await route.fulfill({ response }).catch(() => {});
    finished();
  });
  try {
    await loginErp(page, "operator", `/sales-plans?plan=${a.plan.id}`);
    await captured;
    await page.evaluate((id) => history.pushState(null, "", `/sales-plans?plan=${id}`), b.plan.id);
    await expect(name(page)).toHaveValue(b.plan.fields.name);
    await expect(notice(page).getByText(b.ids[0]!, { exact: true })).toBeVisible();
    release();
    await delivered;
    await expect(notice(page).getByText(b.ids[0]!, { exact: true })).toBeVisible();
    await expect(notice(page).getByText(a.ids[0]!, { exact: true })).toHaveCount(0);
  } finally {
    release();
  }
});
test("a read-only user cannot repair or read the private source behind a supplied reference ID", async ({
  page,
}) => {
  const f = await seed(1);
  await changeErpRights("readonly", ["product:read"]);
  await loginErp(page, "readonly", `/sales-plans?plan=${f.plan.id}`);
  await expect(notice(page).getByText(f.ids[0]!, { exact: true })).toBeVisible();
  await expect(page.getByText(f.label, { exact: true })).toHaveCount(0);
  await expect(
    notice(page).getByRole("button", { name: `移除研究商品关联 ${f.ids[0]}`, exact: true }),
  ).toBeDisabled();
  expect(
    (await (await api(`sales-plans/${f.plan.id}`)).json()).plan.fields.researchItemIds,
  ).toEqual(f.ids);
});
