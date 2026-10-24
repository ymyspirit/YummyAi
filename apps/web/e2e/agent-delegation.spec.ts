import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page, type Route, type TestInfo } from "@playwright/test";
import { erpSessionAuthority, ErpSessionViewSchema } from "@yummyai/contracts/auth/session";
import { CreatedIntegrationApiClientViewSchema, IntegrationWorkspaceViewSchema, RevokedIntegrationApiClientViewSchema, type CreateIntegrationApiClientInput } from "@yummyai/contracts/integration";
import { auditEvents, connectDatabase, integrationApiClientEvents, integrationApiClients, roles, withTenant } from "@yummyai/database";
import { asc, eq } from "drizzle-orm";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";
import { actors, loginErp } from "./erp-identity-fixture";

const databaseUrl = new URL(requireDisposableIntegrationEnvironment()), api = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid");
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(databaseUrl.pathname)?.[1];
if (!nonce || !["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname) || !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) || api.port !== "8130" ||
  process.env.E2E_AGENT_DELEGATION_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" ||
  process.env.E2E_COMPILED_WEB !== "1" || process.env.WEB_AUTH_MODE !== "personal" || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !process.env.ERP_FIXTURE_ACTORS)
  throw new Error("Client delegation browser requires its exact compiled personal nonce database and private bucket before connection");

const endpoint = "/api/integration-clients/", route = "/operating-cockpit";
const drawer = (page: Page) => page.getByRole("dialog", { name: "创建只读客户端", exact: true });
const receiptRegion = (page: Page) => page.getByRole("region", { name: "客户端操作回执", exact: true });
test.setTimeout(150_000);

async function ready(page: Page) {
  await expect(page.getByRole("heading", { name: "运营驾驶舱", exact: true })).toBeVisible();
  const workspace = page.getByRole("region", { name: "开放集成", exact: true });
  await expect(workspace).toBeVisible(); return workspace;
}
async function createForm(page: Page, label: string) {
  await (await ready(page)).getByRole("button", { name: "创建只读客户端", exact: true }).click();
  const form = drawer(page).getByRole("form", { name: "创建只读客户端委派", exact: true });
  await expect(form).toBeVisible(); await form.getByRole("textbox", { name: "客户端名称", exact: true }).fill(label);
  await form.getByRole("checkbox", { name: /^库存 inventory:read$/ }).check();
  await expect(form.getByRole("combobox", { name: "授权范围 库存", exact: true })).toHaveValue("self");
  await expect(form).toContainText("self/team 业务适配待验证 当前仅可读取能力目录");
  return form;
}
async function current(page: Page) {
  const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200);
  const parsed = ErpSessionViewSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Synthetic current session DTO invalid"); return parsed.data;
}
async function workspaceRead(page: Page) {
  const response = await page.request.get(endpoint + "workspace", { headers: { "x-yummyai-context-authority": erpSessionAuthority(await current(page)) } });
  expect(response.status()).toBe(200); const parsed = IntegrationWorkspaceViewSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Synthetic delegation workspace DTO invalid"); return parsed.data;
}
function observe(page: Page) {
  const posts: Array<{ path: string; body: unknown }> = [], consoleErrors: Array<{ path: string; kind: "expected_network_failure" | "unexpected" }> = [], pageErrors: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path.startsWith(endpoint)) posts.push({ path, body: request.postDataJSON() }); });
  // Never retain raw console messages, response bodies or credentials in evidence.
  page.on("console", message => { if (message.type() !== "error") return; let path = "";
    try { path = new URL(message.location().url).pathname; } catch { /* An unknown location remains unexpected. */ }
    consoleErrors.push({ path, kind: /net::ERR_FAILED/.test(message.text()) ? "expected_network_failure" : "unexpected" }); });
  page.on("pageerror", () => pageErrors.push("unexpected_page_error"));
  return { posts, consoleErrors, pageErrors };
}
async function noCredentialCopies(page: Page, token: string) {
  const clean = await page.evaluate(value => {
    const nodes = Array.from(document.querySelectorAll("input, textarea"));
    return !document.documentElement.textContent?.includes(value) && nodes.every(node => !(node as HTMLInputElement).value.includes(value)) &&
      [localStorage, sessionStorage].every(storage => Object.keys(storage).every(key => !key.includes(value) && !storage.getItem(key)?.includes(value))) && !location.href.includes(value);
  }, token);
  expect(clean).toBe(true);
}
async function screenshot(page: Page, info: TestInfo, name: string, target: Locator) {
  await target.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const element of await page.locator(".ic-panel, .task-drawer[open], .ic-dialog").all()) if (await element.isVisible())
    expect(await element.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath(name + ".png"), fullPage: false, mask: [page.locator("[data-private-secret]")] });
}
async function state(account: "operator" | "readonly", id: string) {
  const actor = actors()[account], database = connectDatabase();
  try {
    return await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" }, async tx => ({
      rows: await tx.select({ id: integrationApiClients.id, status: integrationApiClients.status, key: integrationApiClients.idempotencyKey,
        delegation: integrationApiClients.delegation }).from(integrationApiClients).where(eq(integrationApiClients.id, id)),
      events: await tx.select({ id: integrationApiClientEvents.id, action: integrationApiClientEvents.action, key: integrationApiClientEvents.idempotencyKey }).from(integrationApiClientEvents).where(eq(integrationApiClientEvents.clientId, id)).orderBy(asc(integrationApiClientEvents.id)),
      audit: await tx.select({ id: auditEvents.id, action: auditEvents.action }).from(auditEvents).where(eq(auditEvents.entityId, id)).orderBy(asc(auditEvents.id)),
    }));
  } finally { await database.client.end(); }
}
async function savedRole() {
  const actor = actors().readonly, database = connectDatabase();
  try {
    const [row] = await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" }, tx =>
      tx.select({ permissions: roles.permissions, dataScope: roles.dataScope }).from(roles).where(eq(roles.id, actor.roleId)));
    if (!row) throw new Error("Synthetic delegation role missing"); return row;
  } finally { await database.client.end(); }
}
async function setRole(value: Awaited<ReturnType<typeof savedRole>>) {
  const actor = actors().readonly, database = connectDatabase();
  try {
    const rows = await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" }, tx =>
      tx.update(roles).set(value).where(eq(roles.id, actor.roleId)).returning({ id: roles.id }));
    expect(rows).toHaveLength(1);
  } finally { await database.client.end(); }
}

test("a personal client is issued once and an uncertain real create replays only its original receipt before revoke", async ({ page }, info) => {
  const seen = observe(page), label = `SYNTHETIC-CLIENT-${randomUUID()}`;
  await page.setViewportSize({ width: 1440, height: 1000 }); await loginErp(page, "operator", route);
  const abandoned = await createForm(page, "Synthetic unsent client");
  page.once("dialog", dialog => dialog.dismiss()); await drawer(page).getByRole("button", { name: "关闭客户端填写", exact: true }).click();
  await expect(abandoned.getByRole("textbox", { name: "客户端名称", exact: true })).toHaveValue("Synthetic unsent client");
  page.once("dialog", dialog => dialog.accept()); await drawer(page).getByRole("button", { name: "关闭客户端填写", exact: true }).click();
  await expect(drawer(page)).toHaveCount(0); expect(seen.posts).toHaveLength(0);

  const form = await createForm(page, label);
  const [response] = await Promise.all([page.waitForResponse(value => new URL(value.url()).pathname === endpoint + "clients" && value.request().method() === "POST"),
    form.getByRole("button", { name: "创建委派并显示一次凭据", exact: true }).click()]);
  expect(response.status()).toBe(201); const parsed = CreatedIntegrationApiClientViewSchema.safeParse(await response.json());
  if (!parsed.success || !parsed.data.bearerToken) throw new Error("Synthetic new client did not return a one-time credential");
  const token = parsed.data.bearerToken, firstId = parsed.data.client.id;
  expect(token.length >= 40).toBe(true); await expect(receiptRegion(page)).toContainText("客户端已登记");
  expect(await receiptRegion(page).locator("[data-private-secret]").evaluate((node, value) => (node as HTMLInputElement).value === value, token)).toBe(true);
  const firstInput = response.request().postDataJSON() as CreateIntegrationApiClientInput;
  expect(firstInput.scopeLimits).toEqual({ "inventory:read": "self" }); expect(firstInput.teamIds).toBeUndefined();
  const original = await state("operator", firstId); expect(original.rows).toHaveLength(1); expect(original.events.map(row => row.action)).toEqual(["created"]);
  expect(original.audit.map(row => row.action)).toEqual(["integration.api_client.create"]);
  await screenshot(page, info, "agent-delegation-one-time-desktop", receiptRegion(page));
  await drawer(page).getByRole("button", { name: "关闭客户端填写", exact: true }).click(); await expect(drawer(page)).toHaveCount(0); await noCredentialCopies(page, token);

  const unknownLabel = `SYNTHETIC-UNKNOWN-${randomUUID()}`, pattern = "**/api/integration-clients/clients";
  let interrupted = false, lostId = "", hadSecret = false, firstBody: unknown;
  const lose = async (request: Route) => {
    if (request.request().method() !== "POST" || interrupted) { await request.continue(); return; }
    interrupted = true; firstBody = request.request().postDataJSON();
    const actual = await request.fetch(), result = CreatedIntegrationApiClientViewSchema.safeParse(await actual.json());
    if (actual.status() !== 201 || !result.success) throw new Error("Synthetic uncertain create did not commit through the real API");
    lostId = result.data.client.id; hadSecret = Boolean(result.data.bearerToken); await request.abort("failed");
  };
  await page.route(pattern, lose);
  try {
    await (await createForm(page, unknownLabel)).getByRole("button", { name: "创建委派并显示一次凭据", exact: true }).click();
    const review = drawer(page).getByRole("region", { name: "原客户端请求核对", exact: true });
    await expect(review.getByRole("button", { name: "按原正文和编号核对结果", exact: true })).toBeEnabled();
    expect(interrupted && Boolean(lostId) && hadSecret).toBe(true); const committed = await state("operator", lostId);
    expect(committed.events.map(row => row.action)).toEqual(["created"]); expect(committed.audit).toHaveLength(1);
    await drawer(page).getByRole("button", { name: "关闭客户端填写", exact: true }).click(); await expect(drawer(page)).toHaveCount(0);
    await page.getByRole("button", { name: "恢复原客户端请求", exact: true }).click();
    const [replayed] = await Promise.all([page.waitForResponse(value => new URL(value.url()).pathname === endpoint + "clients" && value.request().method() === "POST"),
      drawer(page).getByRole("button", { name: "按原正文和编号核对结果", exact: true }).click()]);
    expect(replayed.status()).toBe(201); expect(replayed.request().postDataJSON()).toEqual(firstBody);
    const replay = CreatedIntegrationApiClientViewSchema.safeParse(await replayed.json());
    if (!replay.success) throw new Error("Synthetic replay DTO invalid");
    expect(replay.data.client.id).toBe(lostId); expect(replay.data.bearerToken === null).toBe(true);
    await expect(receiptRegion(page)).toContainText("原请求已登记 凭据不再复显"); await expect(receiptRegion(page).locator("[data-private-secret]")).toHaveCount(0);
    expect(await state("operator", lostId)).toEqual(committed);
    await drawer(page).getByRole("button", { name: "关闭客户端填写", exact: true }).click(); await expect(drawer(page)).toHaveCount(0);
  } finally { await page.unroute(pattern, lose); }

  const workspace = await ready(page); await workspace.getByRole("button", { name: "撤销客户端 " + unknownLabel, exact: true }).click();
  const revoke = page.getByRole("dialog", { name: "撤销客户端", exact: true }).getByRole("form", { name: "撤销只读客户端", exact: true });
  await revoke.getByRole("textbox", { name: "撤销原因代码", exact: true }).fill("SYNTHETIC_CREDENTIAL_NOT_SAVED");
  await revoke.getByRole("checkbox", { name: "我已核对原客户端 撤销后原凭据不能继续调用", exact: true }).check();
  const [revoked] = await Promise.all([page.waitForResponse(value => new URL(value.url()).pathname === endpoint + `clients/${lostId}/revoke` && value.request().method() === "POST"),
    revoke.getByRole("button", { name: "撤销这笔客户端凭据", exact: true }).click()]);
  expect(revoked.status()).toBe(201); const revokedResult = RevokedIntegrationApiClientViewSchema.safeParse(await revoked.json());
  if (!revokedResult.success) throw new Error("Synthetic revoke DTO invalid");
  expect(revokedResult.data.client.id).toBe(lostId); expect(revokedResult.data.client.credentialState).toBe("revoked");
  const final = await state("operator", lostId); expect(final.events.map(row => row.action)).toEqual(["created", "revoked"]);
  expect(final.audit.map(row => row.action)).toEqual(["integration.api_client.create", "integration.api_client.revoke"]);
  expect(seen.posts.map(item => item.path)).toEqual([endpoint + "clients", endpoint + "clients", endpoint + "clients", endpoint + `clients/${lostId}/revoke`]);
  expect(seen.pageErrors).toHaveLength(0);
  expect(seen.consoleErrors.filter(item => item.kind !== "expected_network_failure" || item.path !== endpoint + "clients")).toHaveLength(0);
  expect(seen.consoleErrors.length <= 1).toBe(true);
  await info.attach("delegation-original-proof", { contentType: "application/json", body: JSON.stringify({ nonce, firstId, lostId, originalBodyReplayed: true, oneTimeOnly: true,
    originalCreateCount: original.events.length, recoveredCreateCount: final.events.filter(row => row.action === "created").length, revokeCount: final.events.filter(row => row.action === "revoked").length,
    consoleErrorCount: seen.consoleErrors.length, pageErrorCount: seen.pageErrors.length }) });
});

test("a mobile reader cannot manage clients and a committed late credential stays hidden after current read authority is removed", async ({ page }, info) => {
  const original = await savedRole(), seen = observe(page), label = `SYNTHETIC-LATE-CLIENT-${randomUUID()}`;
  let primaryFailure: unknown;
  let release: (() => void) | undefined, started = false, finished = false, handlerFailure = false, createdId = "", hadSecret = false, token = "";
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pattern = "**/api/integration-clients/clients";
  const hold = async (request: Route) => {
    if (request.request().method() !== "POST" || started) { await request.continue(); return; } started = true;
    try {
      const response = await request.fetch(), value = CreatedIntegrationApiClientViewSchema.safeParse(await response.json());
      if (response.status() !== 201 || !value.success || !value.data.bearerToken) throw new Error("Synthetic late create did not commit");
      createdId = value.data.client.id; token = value.data.bearerToken; hadSecret = true; await gate;
      try { await request.fulfill({ response }); } catch { if (!request.request().failure()) throw new Error("Synthetic late client response was not cancelled by navigation"); }
    } catch { handlerFailure = true; } finally { finished = true; }
  };
  try {
    const retained = original.permissions.filter(bit => bit !== "integration:manage" && bit !== "integration:read");
    await setRole({ dataScope: "tenant", permissions: [...new Set([...retained, "integration:read", "inventory:read"])] });
    await page.setViewportSize({ width: 390, height: 844 }); await loginErp(page, "readonly", route);
    const region = await ready(page); await expect(region.getByRole("button", { name: "创建只读客户端", exact: true })).toHaveCount(0);
    const before = await workspaceRead(page); expect(before.clientAdmission.canManage).toBe(false);
    const catalog = region.locator("details.ic-catalog"); await catalog.locator("summary").first().click();
    await expect(catalog).toContainText("当前没有可通过统一 Agent 调用的动作");
    await screenshot(page, info, "agent-delegation-readonly-mobile", catalog);

    await setRole({ dataScope: "tenant", permissions: [...new Set([...retained, "integration:read", "integration:manage", "inventory:read"])] });
    await loginErp(page, "readonly", route); await page.route(pattern, hold);
    await (await createForm(page, label)).getByRole("button", { name: "创建委派并显示一次凭据", exact: true }).click();
    await expect.poll(() => Boolean(createdId) && hadSecret, { timeout: 20_000 }).toBe(true);
    const committed = await state("readonly", createdId); expect(committed.rows).toHaveLength(1); expect(committed.events).toHaveLength(1); expect(committed.audit).toHaveLength(1);
    await setRole({ dataScope: "tenant", permissions: [...new Set([...retained, "integration:manage", "inventory:read"])] });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(async () => !(await current(page)).permissions.includes("integration:read"), { timeout: 20_000 }).toBe(true);
    await expect(drawer(page)).toHaveCount(0); await expect(page.locator("body")).not.toContainText(label);
    if (!release) throw new Error("Synthetic late credential gate missing"); release();
    await expect.poll(() => finished, { timeout: 20_000 }).toBe(true); expect(handlerFailure).toBe(false);
    await expect(receiptRegion(page)).toHaveCount(0); await expect(page.locator("[data-private-secret]")).toHaveCount(0); await noCredentialCopies(page, token);
    const denied = await page.request.get(endpoint + "workspace", { headers: { "x-yummyai-context-authority": erpSessionAuthority(await current(page)) } });
    expect(denied.status()).toBe(403); expect(await state("readonly", createdId)).toEqual(committed);
    await screenshot(page, info, "agent-delegation-authority-cleared-mobile", page.getByRole("heading", { name: "运营驾驶舱", exact: true }));
    expect(seen.posts).toHaveLength(1); expect(seen.pageErrors).toHaveLength(0); expect(seen.consoleErrors).toHaveLength(0);
    await info.attach("delegation-authority-proof", { contentType: "application/json", body: JSON.stringify({ nonce, clientId: createdId, realCreateCommitted: true,
      currentReadRemoved: true, delayedCredentialHidden: true, rows: committed.rows.length, createdEvents: committed.events.length, audits: committed.audit.length,
      consoleErrorCount: seen.consoleErrors.length, pageErrorCount: seen.pageErrors.length }) });
  } catch (error) { primaryFailure = error; }
  const failures: unknown[] = primaryFailure === undefined ? [] : [primaryFailure];
  try {
    if (release) release(); if (started) await expect.poll(() => finished, { timeout: 20_000 }).toBe(true); await page.unroute(pattern, hold);
    if (handlerFailure) failures.push(new Error("Synthetic late credential gate failed"));
  } catch (error) { failures.push(error); }
  token = "";
  try { await setRole(original); } catch (error) { failures.push(error); }
  if (failures.length > 1) throw new AggregateError(failures, "Synthetic delegation assertion or cleanup failed");
  if (failures.length === 1) throw failures[0];
});
