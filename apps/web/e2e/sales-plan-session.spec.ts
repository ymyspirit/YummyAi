import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { changeErpRights, identityControl, loginErp, scopedErpRole } from "./erp-identity-fixture";

const reads = ["product:read", "listing:read"];
async function api(path: string, method = "GET", body?: unknown, account = "operator") {
  if (process.env.E2E_ISOLATED_DAILY !== "1") throw Error("Disposable sales-plan session required");
  const { access_token: token } = await identityControl("token", { account });
  return fetch(`${process.env.API_BASE_URL}/v1/${path}`, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
  });
}
async function create(path: string, body: unknown, account = "operator") {
  const response = await api(path, "POST", body, account);
  expect(response.status).toBe(201);
  return response.json();
}
async function spu(account = "operator") {
  return (
    await create(
      "product-development/spus",
      {
        code: `SESSION-${randomUUID().slice(0, 8)}`,
        name: `Synthetic session product ${randomUUID()}`,
        idempotencyKey: randomUUID(),
      },
      account,
    )
  ).spu;
}
async function seed() {
  const source = await spu(),
    plans = [];
  for (const suffix of ["A", "B"])
    plans.push(
      (
        await create("sales-plans", {
          spuId: source.id,
          fields: {
            name: `Synthetic plan ${suffix} ${randomUUID()}`,
            mode: "custom",
            fulfillment: "fbm",
            marketplaceId: "ATVPDKIKX0DER",
          },
          idempotencyKey: randomUUID(),
        })
      ).plan,
    );
  return { source, a: plans[0]!, b: plans[1]! };
}
const nameField = (page: Page) => page.getByLabel("方案名称", { exact: true });
async function switchPlan(page: Page, id: string) {
  await page.evaluate((id) => history.pushState(null, "", `/sales-plans?plan=${id}`), id);
}
const focus = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("focus")));
async function readerWriter(scope: "self" | "tenant" = "tenant") {
  await changeErpRights("readonly", reads);
  return scopedErpRole(["product:write"], scope);
}

test("keeps the original revision and local draft through refresh, conflict and soft record switches", async ({
  page,
}) => {
  const { a, b } = await seed(),
    role = await readerWriter();
  try {
    await loginErp(page, "readonly", `/sales-plans?plan=${a.id}`);
    const draft = "Synthetic unsaved plan A draft";
    await nameField(page).fill(draft);
    await focus(page);
    await expect(nameField(page)).toHaveValue(draft);
    const saved = await api(`sales-plans/${a.id}`, "POST", {
      fields: { ...a.fields, name: "Synthetic concurrent current plan" },
      expectedRevision: a.revision,
      idempotencyKey: randomUUID(),
    });
    expect(saved.status).toBe(201);
    await focus(page);
    await expect(page.getByText("当前方案已有第 2 版", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "保存方案", exact: true }).click();
    await expect(page.locator(".sp-editor .oc-error")).toBeVisible();
    await expect(nameField(page)).toHaveValue(draft);
    await page.getByRole("button", { name: "保留草稿返回列表", exact: true }).click();
    await expect(page.locator(".sp-list")).toBeVisible();
    await switchPlan(page, b.id);
    await expect(nameField(page)).toHaveValue(b.fields.name);
    await switchPlan(page, a.id);
    await expect(nameField(page)).toHaveValue(draft);
    await expect(page.getByText("原草稿仍基于第 1 版", { exact: false })).toBeVisible();
    expect((await (await api(`sales-plans/${a.id}`)).json()).plan.fields.name).toBe(
      "Synthetic concurrent current plan",
    );
  } finally {
    await role.remove();
  }
});

test("a failed B read cannot display A under B's URL and retry opens the actual B", async ({
  page,
}) => {
  const { a, b } = await seed(),
    role = await readerWriter();
  try {
    await loginErp(page, "readonly", `/sales-plans?plan=${a.id}`);
    await expect(nameField(page)).toHaveValue(a.fields.name);
    await page.route(`**/api/sales-plans/${b.id}`, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "Synthetic B unavailable" }),
      }),
    );
    await switchPlan(page, b.id);
    await expect(page.getByText("Synthetic B unavailable", { exact: true })).toBeVisible();
    await expect(page.locator(".sp-editor")).toHaveCount(0);
    await page.unroute(`**/api/sales-plans/${b.id}`);
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect(nameField(page)).toHaveValue(b.fields.name);
  } finally {
    await role.remove();
  }
});

test("temporarily hides an unverifiable plan and restores the same unsaved draft", async ({
  page,
}) => {
  const { a } = await seed(),
    role = await readerWriter();
  try {
    await loginErp(page, "readonly", `/sales-plans?plan=${a.id}`);
    const draft = "Synthetic temporary-outage draft";
    await nameField(page).fill(draft);
    await page.route(`**/api/sales-plans/${a.id}`, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "Synthetic plan check unavailable" }),
      }),
    );
    await focus(page);
    await expect(page.getByText("Synthetic plan check unavailable", { exact: true })).toBeVisible();
    await expect(nameField(page)).not.toBeVisible();
    await page.unroute(`**/api/sales-plans/${a.id}`);
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect(nameField(page)).toBeVisible();
    await expect(nameField(page)).toHaveValue(draft);
  } finally {
    await role.remove();
  }
});

test("write-scope withdrawal clears the foreign draft and neither an old success nor regrant revives it", async ({
  page,
}) => {
  const { a } = await seed(),
    role = await readerWriter();
  let release = () => {},
    started = () => {},
    once = true;
  const captured = new Promise<void>((resolve) => {
      started = resolve;
    }),
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
  try {
    await loginErp(page, "readonly", `/sales-plans?plan=${a.id}`);
    await nameField(page).fill("Synthetic private scope draft");
    await page.route(`**/api/sales-plans/${a.id}`, async (route) => {
      if (!once) {
        await route.continue();
        return;
      }
      once = false;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      started();
      await held;
      await route.fulfill({ response }).catch(() => {});
    });
    await focus(page);
    await captured;
    await role.setScope("self");
    await focus(page);
    await expect(page.getByText("当前方案内容仅可查看", { exact: false })).toBeVisible();
    await expect(nameField(page)).not.toBeEditable();
    await expect(nameField(page)).toHaveValue(a.fields.name);
    release();
    await expect(nameField(page)).toHaveValue(a.fields.name);
    const denied = await api(
      `sales-plans/${a.id}`,
      "POST",
      { fields: a.fields, expectedRevision: a.revision, idempotencyKey: randomUUID() },
      "readonly",
    );
    expect(denied.status).toBe(404);
    await role.setScope("tenant");
    await focus(page);
    await expect(nameField(page)).toBeEditable();
    await expect(nameField(page)).toHaveValue(a.fields.name);
  } finally {
    release();
    await role.remove();
  }
});

test("creates a plan only from a writable SPU and supports separate Custom FBM and standard FBA plans", async ({
  page,
}, info) => {
  const foreign = await spu(),
    role = await readerWriter("self");
  try {
    const own = await spu("readonly");
    expect(
      (
        await api(
          "sales-plans",
          "POST",
          {
            spuId: foreign.id,
            fields: {
              name: "Synthetic forbidden foreign plan",
              mode: "custom",
              fulfillment: "fbm",
            },
            idempotencyKey: randomUUID(),
          },
          "readonly",
        )
      ).status,
    ).toBe(404);
    await loginErp(page, "readonly", `/sales-plans?new=1&spuId=${foreign.id}`);
    const form = page.getByRole("form", { name: "新建销售方案", exact: true });
    await expect(
      form.getByLabel("商品 SPU").locator(`option[value="${foreign.id}"]`),
    ).toHaveAttribute("disabled", "");
    await expect(
      form.getByRole("button", { name: "创建方案并准备印花", exact: true }),
    ).toBeDisabled();
    await form.getByLabel("商品 SPU").selectOption(own.id);
    await form.getByLabel("方案名称", { exact: true }).fill("Synthetic own Custom FBM");
    await expect(form.getByLabel("履约方式").locator('option[value="fba"]')).toHaveCount(0);
    await form.getByRole("button", { name: "创建方案并准备印花", exact: true }).click();
    await expect(page).toHaveURL(
      (url) => !!url.searchParams.get("plan") && !url.searchParams.has("new"),
    );
    await expect(nameField(page)).toHaveValue("Synthetic own Custom FBM");
    const customId = new URL(page.url()).searchParams.get("plan")!;
    const customPlan = await api(`sales-plans/${customId}`);
    expect(customPlan.status).toBe(200);
    expect((await customPlan.json()).plan).toMatchObject({
      spuId: own.id,
      fields: { mode: "custom", fulfillment: "fbm" },
    });
    await page.goto(`/sales-plans?new=1&spuId=${own.id}`);
    await form.getByLabel("方案名称", { exact: true }).fill("Synthetic own standard FBA");
    await form.getByLabel("商品模式").selectOption("standard");
    await form.getByLabel("履约方式").selectOption("fba");
    await form.getByRole("button", { name: "创建方案并准备印花", exact: true }).click();
    await expect(page).toHaveURL(
      (url) =>
        !!url.searchParams.get("plan") &&
        url.searchParams.get("plan") !== customId &&
        !url.searchParams.has("new"),
    );
    await expect(nameField(page)).toHaveValue("Synthetic own standard FBA");
    const standardId = new URL(page.url()).searchParams.get("plan")!;
    expect(standardId).not.toBe(customId);
    const standardPlan = await api(`sales-plans/${standardId}`);
    expect(standardPlan.status).toBe(200);
    expect((await standardPlan.json()).plan).toMatchObject({
      spuId: own.id,
      fields: { mode: "standard", fulfillment: "fba" },
    });
    await page.screenshot({ path: info.outputPath("sales-plan-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("sales-plan-mobile.png"), fullPage: true });
  } finally {
    await role.remove();
  }
});

test("late creation receipt does not navigate away from another selected plan", async ({
  page,
}) => {
  const { source, b } = await seed(),
    role = await readerWriter();
  let release = () => {},
    started = () => {};
  const captured = new Promise<void>((resolve) => {
      started = resolve;
    }),
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
  try {
    await loginErp(page, "readonly", `/sales-plans?new=1&spuId=${source.id}`);
    await nameField(page).fill("Synthetic late created plan");
    await page.route("**/api/sales-plans", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      started();
      await held;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.getByRole("button", { name: "创建方案并准备印花", exact: true }).click();
    await captured;
    await switchPlan(page, b.id);
    await expect(nameField(page)).toHaveValue(b.fields.name);
    const delivered = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().endsWith("/api/sales-plans"),
    );
    release();
    await delivered;
    await expect(page).toHaveURL(new RegExp(`plan=${b.id}`));
    await expect(nameField(page)).toHaveValue(b.fields.name);
  } finally {
    release();
    await role.remove();
  }
});

test("late A save acknowledges the committed A without overwriting the open B", async ({
  page,
}) => {
  const { a, b } = await seed(),
    role = await readerWriter();
  let release = () => {},
    started = () => {};
  const captured = new Promise<void>((resolve) => {
      started = resolve;
    }),
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
  try {
    await loginErp(page, "readonly", `/sales-plans?plan=${a.id}`);
    await nameField(page).fill("Synthetic committed late A");
    await page.route(`**/api/sales-plans/${a.id}`, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      started();
      await held;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.getByRole("button", { name: "保存方案", exact: true }).click();
    await captured;
    await switchPlan(page, b.id);
    await expect(nameField(page)).toHaveValue(b.fields.name);
    const delivered = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/sales-plans/${a.id}`),
    );
    release();
    await delivered;
    await expect(nameField(page)).toHaveValue(b.fields.name);
    await expect(page.getByText("销售方案已保存", { exact: true })).toHaveCount(0);
    expect((await (await api(`sales-plans/${a.id}`)).json()).plan.fields.name).toBe(
      "Synthetic committed late A",
    );
  } finally {
    release();
    await role.remove();
  }
});

test("a draft retry after a soft switch reuses the original receipt instead of creating V02", async ({
  page,
}) => {
  const { a, b } = await seed(),
    writer = await readerWriter(),
    listingRole = await scopedErpRole(["listing:write"], "tenant");
  let release = () => {},
    started = () => {},
    once = true,
    receipt: { listingId: string; listingVersionId: string } | undefined;
  const bodies: Array<{ idempotencyKey: string; expectedListingVersionId: string | null }> = [];
  const captured = new Promise<void>((resolve) => {
      started = resolve;
    }),
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
  try {
    await loginErp(page, "readonly", `/sales-plans?plan=${a.id}&step=4`);
    await page.route(`**/api/sales-plans/${a.id}/draft`, async (route) => {
      bodies.push(route.request().postDataJSON());
      if (!once) {
        await route.continue();
        return;
      }
      once = false;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      receipt = await response.json();
      started();
      await held;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.getByRole("button", { name: "创建刊登草稿", exact: true }).click();
    await captured;
    await switchPlan(page, b.id);
    await expect(nameField(page)).toHaveValue(b.fields.name);
    const delivered = page.waitForResponse((response) =>
      response.url().endsWith(`/api/sales-plans/${a.id}/draft`),
    );
    release();
    await delivered;
    await page.evaluate(
      (id) => history.pushState(null, "", `/sales-plans?plan=${id}&step=4`),
      a.id,
    );
    await page.getByRole("button", { name: "同步为草稿新版本", exact: true }).click();
    await expect(
      page.getByText("本地刊登草稿已保存，请进入刊登审核与平台校验", { exact: true }),
    ).toBeVisible();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.idempotencyKey).toBe(bodies[0]!.idempotencyKey);
    expect(bodies[1]!.expectedListingVersionId).toBeNull();
    const versions = await (await api(`listings/${receipt!.listingId}/versions`)).json();
    expect(versions).toHaveLength(1);
    expect(versions[0].id).toBe(receipt!.listingVersionId);
  } finally {
    release();
    await writer.remove();
    await listingRole.remove();
  }
});

test("Listing write authority can create a local draft without acquiring product write authority", async ({
  page,
}) => {
  const { a } = await seed();
  await changeErpRights("readonly", reads);
  const role = await scopedErpRole(["listing:write"], "tenant");
  try {
    await loginErp(page, "readonly", `/sales-plans?plan=${a.id}&step=4`);
    await expect(nameField(page)).not.toBeEditable();
    await page.getByRole("button", { name: "创建刊登草稿", exact: true }).click();
    await expect(
      page.getByText("本地刊登草稿已保存，请进入刊登审核与平台校验", { exact: true }),
    ).toBeVisible();
    const detail = await (await api(`sales-plans/${a.id}`)).json();
    expect(detail.plan.revision).toBe(a.revision);
    expect(detail.listings).toHaveLength(1);
  } finally {
    await role.remove();
  }
});

test("a committed draft followed by a gateway failure stays uncertain and retries the original version", async ({
  page,
}) => {
  const { a } = await seed();
  await changeErpRights("readonly", reads);
  const role = await scopedErpRole(["listing:write"], "tenant");
  const bodies: Array<{ idempotencyKey: string; expectedListingVersionId: string | null }> = [];
  let receipt: { listingId: string; listingVersionId: string } | undefined;
  try {
    await loginErp(page, "readonly", `/sales-plans?plan=${a.id}&step=4`);
    await page.route(`**/api/sales-plans/${a.id}/draft`, async (route) => {
      bodies.push(route.request().postDataJSON());
      if (bodies.length > 1) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      receipt = await response.json();
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ message: "Synthetic gateway lost the committed response" }),
      });
    });
    const sync = page.getByRole("button", { name: "创建刊登草稿", exact: true });
    await sync.click();
    await expect(
      page.getByText("操作结果尚未确认 请在当前页面重试或重新核对方案", { exact: true }),
    ).toBeVisible();
    expect(bodies).toHaveLength(1);
    expect(await (await api(`listings/${receipt!.listingId}/versions`)).json()).toHaveLength(1);
    await sync.click();
    await expect(
      page.getByText("本地刊登草稿已保存，请进入刊登审核与平台校验", { exact: true }),
    ).toBeVisible();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    const versions = await (await api(`listings/${receipt!.listingId}/versions`)).json();
    expect(versions).toHaveLength(1);
    expect(versions[0].id).toBe(receipt!.listingVersionId);
  } finally {
    await role.remove();
  }
});
