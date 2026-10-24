import { syntheticSpecificationFacts } from "../../../tools/testing/specification-fixtures.js";
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type {
  DevelopmentOptions,
  ProductSpuView,
  SpecificationView,
} from "@yummyai/contracts/catalog/development";
import { apiFetch } from "../src/server-api";
import { actors, identityControl, loginErp, productWriterRole } from "./erp-identity-fixture";

async function create(path: string, data: unknown, actor?: "readonly") {
  if (process.env.E2E_ISOLATED_DAILY !== "1")
    throw Error("Disposable catalog editor fixture required");
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  };
  const url = `${process.env.API_BASE_URL}/v1/${path}`;
  const response = actor
    ? await fetch(url, {
        ...init,
        headers: {
          ...init.headers,
          authorization: `Bearer ${(await identityControl("token", { account: actor })).access_token}`,
        },
      })
    : await apiFetch(url, init);
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json();
}
async function seed(actor?: "readonly", teamId?: string, stockItemId?: string) {
  const code = `EDIT-${randomUUID().slice(0, 8)}`;
  const { spu } = (await create(
    "product-development/spus",
    {
      code,
      name: `Synthetic ${code}`,
      ...(teamId ? { teamId } : {}),
      idempotencyKey: randomUUID(),
    },
    actor,
  )) as { spu: ProductSpuView };
  const { specification } = (await create(
    "product-development/specifications",
    {
      spuId: spu.id,
      code: "DEFAULT",
      name: `Specification ${code}`,
      attributes: { size: "50mm" },
      ...(stockItemId ? { stockItemId } : {}),
      facts: syntheticSpecificationFacts({
        material: "Synthetic",
        dimensions: "50mm",
        packageContents: "1 synthetic item",
        packageQuantity: 1,
        factsConfirmed: false,
      }),
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
    },
    actor,
  )) as { specification: SpecificationView };
  return { spu, specification };
}
const href = (spu: ProductSpuView) => `/product-specifications?spu=${spu.id}&editSpu=1`;
const specHref = (spu: ProductSpuView, specification: SpecificationView) =>
  `/product-specifications?spu=${spu.id}&form=1&specificationVersionId=${specification.versionId}`;
const nameInput = (page: Page) => page.getByRole("dialog").locator('input[name="name"]');
const switchObject = (page: Page, url: string) =>
  page.evaluate((next) => history.replaceState(null, "", next), url);
const focus = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("focus")));
async function options() {
  const response = await apiFetch(`${process.env.API_BASE_URL}/v1/product-development/options`);
  expect(response.ok).toBe(true);
  return response.json() as Promise<DevelopmentOptions>;
}
async function update(spu: ProductSpuView, patch: Record<string, unknown>) {
  const current = (await options()).spus.find((item) => item.id === spu.id)!;
  return create(`product-development/spus/${spu.id}`, {
    code: current.code,
    name: current.name,
    description: current.description,
    capabilities: current.capabilities,
    expectedRevision: current.revision,
    ...patch,
    idempotencyKey: randomUUID(),
  });
}

test("direct foreign editors and mismatched parent URLs stay read only while own writes remain usable", async ({
  page,
}) => {
  const role = await productWriterRole("self");
  try {
    const foreign = await seed(),
      own = await seed("readonly");
    await loginErp(page, "readonly", href(foreign.spu));
    await expect(page.getByText("当前资料超出编辑范围 可继续查看已授权内容")).toBeVisible();
    await expect(page.getByRole("button", { name: "保存 SPU 基础信息", exact: true })).toHaveCount(
      0,
    );
    await page.goto(`/product-specifications?spu=${foreign.spu.id}&form=1`);
    await expect(page.getByText("当前资料超出编辑范围 可继续查看已授权内容")).toBeVisible();
    await page.goto(specHref(own.spu, foreign.specification));
    await expect(page.getByText("要编辑的资料当前不可用 请关闭后刷新列表")).toBeVisible();
    await page.goto(href(own.spu));
    await expect(nameInput(page)).toHaveValue(own.spu.name);
    await nameInput(page).fill(`${own.spu.name} reviewed`);
    await page.getByRole("button", { name: "保存 SPU 基础信息", exact: true }).click();
    await expect
      .poll(async () => (await options()).spus.find((spu) => spu.id === own.spu.id)?.name)
      .toBe(`${own.spu.name} reviewed`);
  } finally {
    await role.remove();
  }
});

test("switching specification objects preserves each draft under its own key", async ({ page }) => {
  const first = await seed(),
    second = await seed();
  await loginErp(page, "operator", specHref(first.spu, first.specification));
  await expect(nameInput(page)).toHaveValue(first.specification.name);
  await nameInput(page).fill("Synthetic draft A");
  await switchObject(page, specHref(second.spu, second.specification));
  await expect(nameInput(page)).toHaveValue(second.specification.name);
  await nameInput(page).fill("Synthetic draft B");
  await switchObject(page, specHref(first.spu, first.specification));
  await expect(nameInput(page)).toHaveValue("Synthetic draft A");
  await switchObject(page, specHref(second.spu, second.specification));
  await expect(nameInput(page)).toHaveValue("Synthetic draft B");
});

test("background refresh keeps the original optimistic version and preserves a conflicted draft", async ({
  page,
}) => {
  const { spu } = await seed();
  await loginErp(page, "operator", href(spu));
  await expect(nameInput(page)).toHaveValue(spu.name);
  await nameInput(page).fill("Synthetic local unsaved edit");
  await update(spu, { name: "Synthetic external revision" });
  const refreshed = page.waitForResponse(
    (response) =>
      response.url().includes("/api/product-development/options") && response.status() === 200,
  );
  await focus(page);
  await refreshed;
  await expect(nameInput(page)).toHaveValue("Synthetic local unsaved edit");
  const rejected = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/spus/${spu.id}`) && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "保存 SPU 基础信息", exact: true }).click();
  expect((await rejected).status()).toBe(409);
  await expect(nameInput(page)).toHaveValue("Synthetic local unsaved edit");
  expect((await options()).spus.find((item) => item.id === spu.id)?.name).toBe(
    "Synthetic external revision",
  );
});

test("a late successful save for A does not close or overwrite editor B", async ({ page }) => {
  const first = await seed(),
    second = await seed();
  let release!: () => void, captured!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      captured = resolve;
    });
  try {
    await loginErp(page, "operator", href(first.spu));
    await expect(nameInput(page)).toHaveValue(first.spu.name);
    await nameInput(page).fill("Synthetic completed A");
    await page.route(`**/api/product-development/spus/${first.spu.id}`, async (route) => {
      const response = await route.fetch();
      captured();
      await held;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.getByRole("button", { name: "保存 SPU 基础信息", exact: true }).click();
    await started;
    await switchObject(page, href(second.spu));
    await expect(nameInput(page)).toHaveValue(second.spu.name);
    release();
    await expect(
      page.getByRole("button", { name: "保存 SPU 基础信息", exact: true }),
    ).toBeEnabled();
    expect(new URL(page.url()).searchParams.get("spu")).toBe(second.spu.id);
    await expect(nameInput(page)).toHaveValue(second.spu.name);
    expect((await options()).spus.find((item) => item.id === first.spu.id)?.name).toBe(
      "Synthetic completed A",
    );
  } finally {
    release();
  }
});

test("temporary authority reads hide body and portal actions then restore the same draft", async ({
  page,
}) => {
  const { spu } = await seed();
  await loginErp(page, "operator", href(spu));
  await expect(nameInput(page)).toHaveValue(spu.name);
  await nameInput(page).fill("Synthetic draft preserved through network failure");
  await page.route("**/api/product-development/options", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ message: "Synthetic temporary read failure" }),
    }),
  );
  await focus(page);
  await expect(page.getByRole("heading", { name: "核对商品访问范围", exact: true })).toBeVisible();
  await expect(nameInput(page)).toBeHidden();
  await expect(page.getByRole("button", { name: "保存 SPU 基础信息", exact: true })).toBeHidden();
  await page.unroute("**/api/product-development/options");
  await focus(page);
  await expect(nameInput(page)).toHaveValue("Synthetic draft preserved through network failure");
  await expect(nameInput(page)).toBeEditable();
  await expect(page.getByRole("button", { name: "保存 SPU 基础信息", exact: true })).toBeEnabled();
});

test("root reassignment clears the editor and rejects an older late options response", async ({
  page,
}) => {
  const role = await productWriterRole("team");
  let release = () => {};
  try {
    const team = await create("teams", {
      name: `Synthetic editor ${randomUUID()}`,
      requestId: randomUUID(),
      reason: "Synthetic ownership setup",
    });
    await create(`teams/${team.id}/members`, {
      membershipId: actors().readonly.membershipId,
      active: true,
      expectedRevision: null,
      requestId: randomUUID(),
      reason: "Synthetic editor membership",
    });
    const { spu } = await seed(undefined, team.id);
    await loginErp(page, "readonly", href(spu));
    await expect(nameInput(page)).toHaveValue(spu.name);
    await nameInput(page).fill("Synthetic revoked private draft");
    let once = true,
      captured!: () => void;
    const started = new Promise<void>((resolve) => {
        captured = resolve;
      }),
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    await page.route("**/api/product-development/options", async (route) => {
      if (!once) {
        await route.continue();
        return;
      }
      once = false;
      const response = await route.fetch();
      captured();
      await held;
      await route.fulfill({ response }).catch(() => {});
    });
    await focus(page);
    await started;
    await update(spu, { teamId: null });
    await focus(page);
    await expect(page.getByText("当前资料超出编辑范围 可继续查看已授权内容")).toBeVisible();
    release();
    await expect(page.getByRole("button", { name: "保存 SPU 基础信息", exact: true })).toHaveCount(
      0,
    );
    await expect(nameInput(page)).toHaveCount(0);
  } finally {
    release();
    await role.remove();
  }
});

test("inactive specification references stay selected until the operator explicitly clears them", async ({
  page,
}) => {
  const stock = await create("inventory/stock-items", {
    skuId: null,
    code: `REFERENCE-${randomUUID().slice(0, 8).toUpperCase()}`,
    name: "Synthetic reference material",
    baseUnit: "each",
  });
  const { spu, specification } = await seed(undefined, undefined, stock.id);
  await loginErp(page, "operator", specHref(spu, specification));
  const picker = page.getByRole("dialog").locator('select[name="stock"]');
  await expect(picker).toHaveValue(stock.id);
  const response = await apiFetch(
    `${process.env.API_BASE_URL}/v1/inventory/stock-items/${stock.id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: stock.name, status: "inactive" }),
    },
  );
  expect(response.status).toBe(200);
  const refreshed = page.waitForResponse(
    (response) =>
      response.url().includes("/api/product-development/options") && response.status() === 200,
  );
  await focus(page);
  await refreshed;
  await expect(page.getByText("关联资料已不可用 请重新选择或明确清除关联")).toBeVisible();
  await expect(picker).toHaveValue(stock.id);
  const save = page.getByRole("button", { name: "保存新版本", exact: true });
  await expect(save).toBeDisabled();
  await picker.selectOption("");
  await expect(save).toBeEnabled();
  await save.click();
  await expect
    .poll(async () => {
      const current = (await options()).specifications.find((item) => item.id === specification.id);
      return current?.version === 2 && current.stockItemId === null;
    })
    .toBe(true);
});

test("actual editor remains usable without overflow at desktop and mobile widths", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { spu } = await seed();
  await loginErp(page, "operator", href(spu));
  await expect(nameInput(page)).toHaveValue(spu.name);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(nameInput(page)).toBeEditable();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const dialog = page.getByRole("dialog");
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`catalog-editor-${width}.png`), fullPage: true });
  }
  if (process.env.E2E_COMPILED_WEB === "1")
    await expect(page.locator("nextjs-portal")).toHaveCount(0);
  expect(errors).toEqual([]);
});
