import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createEntityId } from "@yummyai/contracts";
import { apiFetch } from "../src/server-api";
import {
  changeErpRights,
  identityControl,
  loginErp,
  productWriterRole,
} from "./erp-identity-fixture";

test("historical multi-SPU plans keep both original links and reject default shared edits", async ({ page }, info) => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(url.pathname)) throw Error("Disposable legacy product fixture required");
  const code = "LEGACY-" + randomUUID().slice(0, 8), secondId = createEntityId();
  const { spu } = await create("product-development/spus", { code, name: "Synthetic historical product", idempotencyKey: randomUUID() });
  const require = createRequire(new URL("../../../packages/database/package.json", import.meta.url));
  const database = require("postgres")(url.toString(), { max: 1 });
  try {
    await database.unsafe("update spus set legacy_plan_ambiguous=true where id=$1", [spu.id]);
    await database.unsafe("insert into spus(id,tenant_id,product_plan_id,code,name,customization,legacy_plan_ambiguous) select $1,tenant_id,product_plan_id,$2,'Synthetic second original',customization,true from spus where id=$3", [secondId, code + "-B", spu.id]);
  } finally { await database.end(); }
  const role = await productWriterRole("tenant");
  try {
    await loginErp(page, "readonly", `/products?plan=${spu.productPlanId}`);
    await expect(page.getByRole("heading", { name: "历史商品关系待核对", exact: true })).toBeVisible();
    const links = page.locator(".product-legacy-notice a");
    await expect(links).toHaveCount(2);
    await expect(links.filter({ hasText: code + "-B" })).toHaveAttribute("href", `/product-specifications?spu=${secondId}`);
    await expect(page.getByRole("button", { name: "保存产品计划", exact: true })).toHaveCount(0);
    await expect(page.locator(".product-next-step")).toHaveCount(0);
    await expect(page.getByText("历史关联待核对", { exact: true })).toBeVisible();
    await page.getByRole("heading", { name: "历史商品关系待核对", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("legacy-spu-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("heading", { name: "历史商品关系待核对", exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("legacy-spu-mobile.png") });
    await links.filter({ hasText: code + "-B" }).click();
    await expect(page).toHaveURL(new RegExp(`product-specifications\\?spu=${secondId}`));
    await expect(page.getByText("历史商品关系待核对 共享企划暂时只读 当前显示所选原 SPU 的规格与历史", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "编辑 SPU", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "绑定多个规格", exact: true })).toBeEnabled();
    await page.goto(`/product-specifications?spu=${secondId}&editSpu=1`);
    await expect(page.getByText("历史商品关系待核对 共享企划暂时只读 可继续查看和维护原商品规格", { exact: true })).toBeVisible();
  } finally { await role.remove(); }
});

test("narrowing only the write scope clears a foreign draft while preserving tenant reads and own writes", async ({
  page,
}) => {
  const { plan } = await seed(),
    role = await productWriterRole("tenant");
  let release = () => {};
  try {
    await loginErp(page, "readonly", `/products?plan=${plan.id}`);
    const label = page.getByLabel("客户标签", { exact: true });
    await expect(label).toBeEditable();
    await label.fill("SYNTHETIC UNSAVED SCOPE DRAFT");
    let started!: () => void,
      once = true;
    const captured = new Promise<void>((resolve) => {
        started = resolve;
      }),
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    await page.route("**/api/erp-auth/session", async (route) => {
      if (!once) {
        await route.continue();
        return;
      }
      once = false;
      const response = await route.fetch(),
        value = await response.json();
      expect(value.dataScope).toBe("tenant");
      expect(value.permissionScopes["product:write"]).toBe("tenant");
      started();
      await held;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await captured;
    await role.setScope("self");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("button", { name: "保存产品计划", exact: true })).toHaveCount(0);
    await expect(page.getByText("当前商品超出编辑范围", { exact: true }).first()).toBeVisible();
    await expect(label).toHaveValue("姓名");
    await expect(label).not.toBeEditable();
    await expect(page.locator(".product-create-panel")).toHaveCount(1);
    release();
    await expect(page.getByRole("button", { name: "保存产品计划", exact: true })).toHaveCount(0);
    const session = await (await page.request.get("/api/erp-auth/session")).json();
    expect(session.dataScope).toBe("tenant");
    expect(session.permissions).toContain("product:write");
    expect(session.permissionScopes["product:read"]).toBe("tenant");
    expect(session.permissionScopes["product:write"]).toBe("self");
    const { access_token: token } = await identityControl("token", { account: "readonly" });
    expect(typeof token).toBe("string");
    const denied = await fetch(`${base()}/v1/products/plans/${plan.id}/customization`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ customization: plan.customization }),
    });
    expect(denied.status).toBe(404);
    const ownResponse = await fetch(`${base()}/v1/products/plans`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Synthetic own scoped plan " + randomUUID(),
        sourceReportIds: [],
        customization: plan.customization,
      }),
    });
    expect(ownResponse.status).toBe(201);
    const own = await ownResponse.json();
    await page.goto(`/products?plan=${own.id}`);
    await expect(page.getByRole("button", { name: "保存产品计划", exact: true })).toBeVisible();
    await expect(page.getByLabel("客户标签", { exact: true })).toBeEditable();
  } finally {
    release();
    await role.remove();
  }
});

const readPermissions = ["product:read", "design:read", "research:read", "capture:read"];
const base = () => process.env.API_BASE_URL!;
async function create(path: string, data: unknown) {
  if (process.env.E2E_ISOLATED_DAILY !== "1")
    throw Error("Disposable product access fixture required");
  const response = await apiFetch(`${base()}/v1/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  expect(response.status).toBe(201);
  return response.json();
}
async function seed() {
  const name = `ACCESS ${randomUUID()}`;
  const plan = await create("products/plans", {
    name,
    sourceReportIds: [],
    customization: {
      version: 1,
      fields: [{ key: "buyer_name", label: "姓名", type: "short_text", required: true }],
    },
  });
  const { spu } = await create("product-development/spus", {
    code: `ACCESS-${randomUUID().slice(0, 8)}`,
    name: `SPU ${name}`,
    idempotencyKey: randomUUID(),
  });
  return { plan, spu, name };
}

test("personal product readers can inspect facts without legacy or current development write controls", async ({
  page,
}, info) => {
  const { plan, spu, name } = await seed();
  await loginErp(page, "readonly", `/products?plan=${plan.id}`);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.locator(".product-create-panel")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "提交立项审核", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "保存产品计划", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("客户标签", { exact: true })).not.toBeEditable();
  await expect(page.getByRole("button", { name: "添加字段", exact: true })).toHaveCount(0);
  const { access_token: token } = await identityControl("token", { account: "readonly" });
  for (const [path, method, body] of [
    ["products/plans", "POST", { name: "Synthetic forbidden create" }],
    [`products/plans/${plan.id}/customization`, "PATCH", { customization: plan.customization }],
    [
      "product-development/spus",
      "POST",
      { code: "FORBIDDEN", name: "Synthetic forbidden SPU", idempotencyKey: randomUUID() },
    ],
  ] as const) {
    expect(
      (
        await fetch(`${base()}/v1/${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(403);
  }
  await page.goto(`/product-specifications?spu=${spu.id}&form=1&editSpu=1`);
  await expect(page.getByRole("button", { name: "新增 SPU", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "编辑 SPU", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "绑定多个规格", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "新建销售方案", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "查看销售方案", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存 SPU", exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("readonly-spu-mobile.png"), fullPage: true });
});

test("a personal writer creates a plan and persists its schema through the original server actions", async ({
  page,
}) => {
  const name = `UI PRODUCT ${randomUUID()}`,
    label = `CUSTOM ${randomUUID().slice(0, 8)}`;
  await loginErp(page, "operator");
  const createPanel = page.locator(".product-create-panel");
  if (!(await createPanel.evaluate((element) => (element as HTMLDetailsElement).open)))
    await createPanel.locator(":scope > summary").click();
  await page.locator('.product-create-panel input[name="name"]').fill(name);
  await page.getByRole("button", { name: "创建产品企划", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  const planId = new URL(page.url()).searchParams.get("plan");
  expect(planId).toBeTruthy();
  await page.getByRole("button", { name: "添加字段", exact: true }).click();
  await page.getByLabel("客户标签", { exact: true }).fill(label);
  const keyInput = page.getByLabel("字段键", { exact: true }),
    save = page.getByRole("button", { name: "保存产品计划", exact: true });
  await keyInput.fill("");
  await expect(save).toBeDisabled();
  await expect(keyInput).toBeFocused();
  await keyInput.pressSequentially("customer_text");
  await expect(keyInput).toBeFocused();
  await expect(keyInput).toHaveValue("customer_text");
  await expect(save).toBeEnabled();
  await save.click();
  await expect
    .poll(async () => {
      const result = await apiFetch(`${base()}/v1/products/plans`);
      const plans = await result.json();
      const field = plans.find((plan: { id: string }) => plan.id === planId)?.customization
        .fields[0];
      return field ? { key: field.key, label: field.label } : null;
    })
    .toEqual({ key: "customer_text", label });
  await page.reload();
  await expect(page.getByLabel("客户标签", { exact: true })).toHaveValue(label);
  await expect(page.getByLabel("字段键", { exact: true })).toHaveValue("customer_text");
});

test("product write withdrawal clears dirty controls and ignores an older successful identity response", async ({
  page,
}) => {
  const { plan } = await seed();
  await changeErpRights("readonly", [...readPermissions, "product:write"]);
  let release = () => {};
  try {
    await loginErp(page, "readonly", `/products?plan=${plan.id}`);
    await expect(page.locator(".product-create-panel")).toHaveCount(1);
    await page.locator(".product-create-panel > summary").click();
    const unsaved = `PRIVATE DRAFT ${randomUUID()}`;
    await page.locator('.product-create-panel input[name="name"]').fill(unsaved);
    let started!: () => void,
      once = true;
    const captured = new Promise<void>((resolve) => {
        started = resolve;
      }),
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    await page.route("**/api/erp-auth/session", async (route) => {
      if (!once) {
        await route.continue();
        return;
      }
      once = false;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      expect((await response.json()).permissions).toContain("product:write");
      started();
      await held;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await captured;
    await changeErpRights("readonly", readPermissions);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator(".product-create-panel")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: plan.name, exact: true })).toBeVisible();
    release();
    await expect(page.getByRole("button", { name: "保存产品计划", exact: true })).toHaveCount(0);
    expect(
      await page.locator("input").evaluateAll((nodes) => nodes.map((node) => node.value)),
    ).not.toContain(unsaved);
    expect(
      (await (await page.request.get("/api/erp-auth/session")).json()).permissions,
    ).not.toContain("product:write");
  } finally {
    release();
    await changeErpRights("readonly", readPermissions);
  }
});

test("product write without design review cannot register artwork", async ({ page }) => {
  await changeErpRights("readonly", [...readPermissions, "product:write"]);
  try {
    await loginErp(page, "readonly");
    await page.goto("/print-library?form=1");
    await expect(page.getByText("登记和修改印花需要印花审核权限", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "登记印花", exact: true })).toHaveCount(0);
    await expect(page.locator('form input[name="code"]')).toHaveCount(0);
  } finally {
    await changeErpRights("readonly", readPermissions);
  }
});
