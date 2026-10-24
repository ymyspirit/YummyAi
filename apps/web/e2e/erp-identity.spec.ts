import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { actors, changeErpRights, identityControl, loginErp } from "./erp-identity-fixture";
import { centerApi } from "./order-centers-fixture";
test("personal ERP keeps the operator credential out of unauthenticated pages, APIs and legacy ingress", async ({
  page,
}, testInfo) => {
  for (const path of ["/api/product-development/workspace", "/api/order-centers/workspace"]) {
    const response = await page.request.get(path, {
      headers: { authorization: `Bearer ${process.env.API_ACCESS_TOKEN}` },
    });
    expect(response.status()).toBe(401);
    expect(response.headers()["cache-control"]).toContain("no-store");
  }
  expect((await page.request.post("/v1/captures", { data: {} })).status()).toBe(404);
  await page.goto("/products");
  await expect(page.getByRole("heading", { name: "登录运营工作台" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("personal-login-mobile.png"), fullPage: true });
  const redirect = await page.request.get("/api/erp-auth/login?returnTo=//invalid.example", {
    maxRedirects: 0,
  });
  expect(redirect.status()).toBe(307);
  expect(new URL(redirect.headers().location!).origin).toBe(
    process.env.FACTORY_IDENTITY_FIXTURE_URL,
  );
});
test("personal ERP separates concurrent readers, operators and tenants through real BFF and RSC", async ({
  page,
  browser,
}, testInfo) => {
  const name = `ERP PRIVATE ${randomUUID()}`;
  await centerApi("product-development/spus", {
    code: `ERP-${randomUUID().slice(0, 8)}`,
    name,
    idempotencyKey: randomUUID(),
  });
  await loginErp(page, "readonly");
  const session = await page.request.get("/api/erp-auth/session"),
    view = await session.json();
  expect(view.userId).toBe(actors().readonly.userId);
  expect(view.permissions).not.toContain("product:write");
  const read = await page.request.get("/api/product-development/options");
  expect(read.ok()).toBe(true);
  expect(await read.text()).toContain(name);
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  const denied = await page.request.post("/api/product-development/spus", {
    headers: { origin: "http://localhost:3130" },
    data: { code: "FORGED-WRITE", name: "Must not be created", idempotencyKey: randomUUID() },
  });
  expect(denied.status()).toBe(403);
  const other = await browser.newContext({ baseURL: "http://localhost:3130" });
  try {
    const operator = await other.newPage();
    await loginErp(operator, "operator");
    expect((await (await other.request.get("/api/erp-auth/session")).json()).userId).toBe(
      actors().operator.userId,
    );
    const created = await other.request.post("/api/product-development/spus", {
      headers: { origin: "http://localhost:3130" },
      data: {
        code: `ALLOW-${randomUUID().slice(0, 8)}`,
        name: "Synthetic authorized write",
        idempotencyKey: randomUUID(),
      },
    });
    expect(created.ok()).toBe(true);
    await operator.getByRole("button", { name: "退出登录" }).click();
    await expect(operator.getByRole("heading", { name: "登录运营工作台" })).toBeVisible();
    await loginErp(operator, "outsider");
    const foreign = await other.request.get("/api/product-development/options");
    expect(foreign.ok()).toBe(true);
    expect(await foreign.text()).not.toContain(name);
    await expect(operator.getByText(name, { exact: true })).toHaveCount(0);
  } finally {
    await other.close();
  }
  const cookie = (await page.context().cookies()).find(
    (row) => row.name === "yummyai_erp_session",
  )!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.value).toMatch(/^[\w-]{43}$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("personal-reader-mobile.png"),
    fullPage: true,
  });
});
test("personal ERP clears a revoked account and cannot restore an older successful response or history", async ({
  page,
}) => {
  await loginErp(page, "readonly");
  await page.goto("/product-development");
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  let release!: () => void, ready!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve)),
    captured = new Promise<void>((resolve) => (ready = resolve));
  let once = true;
  await page.route("**/api/product-development/options", async (route) => {
    if (!once) {
      await route.continue();
      return;
    }
    once = false;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    ready();
    await held;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await captured;
  await changeErpRights("readonly", []);
  try {
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("heading", { name: "登录运营工作台" })).toBeVisible();
    release();
    expect((await page.request.get("/api/product-development/workspace")).status()).toBe(401);
    await page.goBack();
    await expect(page.getByRole("heading", { name: "登录运营工作台" })).toBeVisible();
  } finally {
    release();
    await changeErpRights("readonly", [
      "product:read",
      "design:read",
      "research:read",
      "capture:read",
    ]);
  }
  await loginErp(page, "main");
  await expect(page.getByRole("region", { name: "运营账户登录" }).getByRole("alert")).toContainText("尚无运营工作台权限");
});
test("personal ERP rejects cross-origin commands and callback replay without leaking tokens", async ({
  page,
}) => {
  await loginErp(page, "operator");
  expect(
    (
      await page.request.post("/api/erp-auth/logout", {
        headers: { origin: "https://invalid.example" },
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await page.request.post("/api/product-development/spus", {
        headers: { origin: "https://invalid.example" },
        data: {},
      })
    ).status(),
  ).toBe(400);
  const callback = await page.request.get("/api/erp-auth/callback?code=forged&state=forged", {
    maxRedirects: 0,
  });
  expect(callback.status()).toBe(307);
  expect(callback.headers().location).toContain("/login?reason=login_invalid");
  const proof = await identityControl("proof");
  expect(proof.replayedCodes).toBe(0);
  expect(proof.invalidPkce).toBe(0);
});
