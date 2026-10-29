import { expect, test, type APIResponse } from "@playwright/test";
import { ErpSessionViewSchema } from "@yummyai/contracts/auth/session";
import { ContentProjectListSchema } from "@yummyai/contracts/catalog/content-project";
import { PillowProjectWorkspaceSchema } from "@yummyai/contracts/catalog/pillow-project";
import { requireStudioPersonalEnvironment } from "../../../tools/testing/require-studio-personal-environment.mjs";
import { actors, loginErp } from "./erp-identity-fixture.js";

requireStudioPersonalEnvironment(process.env, true);
if (process.env.E2E_STUDIO_CONFIGURATION_ISOLATED !== "1")
  throw new Error("Content project personal reads require the compiled isolated configuration runner");

async function rejected(response: APIResponse, status: number) {
  expect(response.status()).toBe(status);
  expect(response.headers()["cache-control"]).toContain("no-store");
  const body: unknown = await response.json();
  expect(body).toMatchObject({ message: expect.any(String) });
  expect(body).not.toHaveProperty("items");
  expect(body).not.toHaveProperty("orders");
  expect(Object.keys(body as Record<string, unknown>).every(key => key === "message" || key === "code")).toBe(true);
}

test("compiled personal content and pillow lists use real read permissions and reject anonymous or cross-site access", async ({ page, browser }) => {
  // No content-project or identity endpoint is mocked. The disposable tenant
  // intentionally has no projects; an empty list does not prove cross-tenant data isolation.
  const apiWrites: Array<{ method: string; path: string }> = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/") && !path.startsWith("/api/erp-auth/") && request.method() !== "GET")
      apiWrites.push({ method: request.method(), path });
  });
  const contentRead = page.waitForResponse(response => new URL(response.url()).pathname === "/api/content-projects" && response.request().method() === "GET");
  await loginErp(page, "operator", "/content-projects");
  await expect(page).toHaveURL("http://localhost:3130/content-projects");
  const sessionResponse = await page.request.get("/api/erp-auth/session");
  expect(sessionResponse.status()).toBe(200);
  const session = ErpSessionViewSchema.parse(await sessionResponse.json()), operator = actors().operator;
  expect(session.canUseErp).toBe(true);
  expect(session.userId).toBe(operator.userId);
  expect(session.tenantId).toBe(operator.tenantId);
  expect(session.permissions).toContain("design:read");
  expect(session.permissionScopes?.["design:read"]).toBe("tenant");

  const contentResponse = await contentRead;
  expect(contentResponse.status()).toBe(200);
  expect(contentResponse.headers()["cache-control"]).toContain("private");
  expect(contentResponse.headers()["cache-control"]).toContain("no-store");
  expect(ContentProjectListSchema.parse(await contentResponse.json())).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  const content = page.locator("main.cp-page");
  await expect(content.getByRole("heading", { name: "商品图文项目", exact: true })).toBeVisible();
  await expect(content.getByText("共 0 个项目", { exact: true })).toBeVisible();
  await expect(content.getByRole("heading", { name: "开始第一个商品图文项目", exact: true })).toBeVisible();
  await expect(content.getByRole("alert")).toHaveCount(0);
  await expect(content).toHaveAttribute("aria-busy", "false");

  const pillowRead = page.waitForResponse(response => new URL(response.url()).pathname === "/api/content-projects/pillow" && response.request().method() === "GET");
  await page.getByRole("navigation", { name: "商品项目类型", exact: true }).getByRole("link", { name: "异形抱枕", exact: true }).click();
  const pillowResponse = await pillowRead;
  expect(pillowResponse.status()).toBe(200);
  expect(pillowResponse.headers()["cache-control"]).toContain("private");
  expect(pillowResponse.headers()["cache-control"]).toContain("no-store");
  const workspace = PillowProjectWorkspaceSchema.parse(await pillowResponse.json());
  expect(workspace.access).toEqual({ catalog: true, orders: true, details: true });
  expect(workspace.specifications).toEqual([]);
  expect(workspace.artworks).toEqual([]);
  expect(workspace.recipes).toEqual([]);
  expect(workspace.orders).toMatchObject({ items: [], total: 0 });
  const pillow = page.locator("main.cp-pillow");
  await expect(pillow.getByRole("heading", { name: "异形抱枕项目", exact: true })).toBeVisible();
  await expect(pillow.getByText("共 0 个订单商品", { exact: true })).toBeVisible();
  await expect(pillow.getByText("没有匹配的抱枕订单。可调整筛选，或在订单中心为未绑定订单选择抱枕制作方案。", { exact: true })).toBeVisible();
  await expect(pillow.getByRole("alert")).toHaveCount(0);
  await expect(pillow).toHaveAttribute("aria-busy", "false");

  for (const path of ["/api/content-projects", "/api/content-projects/pillow"])
    await rejected(await page.request.get(path, { headers: { "sec-fetch-site": "cross-site" } }), 403);

  // A fresh browser context has no operator session; never copy or inject cookies.
  const anonymous = await browser.newContext({ baseURL: "http://localhost:3130" });
  try {
    for (const path of ["/api/content-projects", "/api/content-projects/pillow"])
      await rejected(await anonymous.request.get(path), 401);
  } finally { await anonymous.close(); }
  expect(apiWrites).toEqual([]);
});
