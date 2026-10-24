import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { FactoryCapabilityViewSchema, FactoryDirectorySchema, FactoryHistorySchema, FactoryViewSchema,
  type FactoryView } from "@yummyai/contracts/suppliers/factory-directory";
import { auditEvents, connectDatabase, factoryCapabilities, factoryCapabilityVersions, fulfillmentFactories,
  fulfillmentFactoryVersions, roles, withTenant } from "@yummyai/database";
import { asc, eq, inArray } from "drizzle-orm";
import { actors, identityControl, loginErp, scopedErpRole } from "./erp-identity-fixture";
import { syntheticFactoryCapability, syntheticFactoryProfile, syntheticSupplierProfile } from "../../../tools/testing/factory-fixtures";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(databaseUrl.pathname)?.[1];
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_FACTORY_AUTHORITY_ISOLATED !== "1" || process.env.WEB_AUTH_MODE !== "personal" ||
  !["postgres:", "postgresql:"].includes(databaseUrl.protocol) || !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Factory authority browser requires its matching personal disposable runner before connecting");
const base = process.env.API_BASE_URL!.replace(/\/$/, ""), read = Permission.OrderRead, write = Permission.OrderWrite;
test.setTimeout(180_000);
const routeFor = (factory: FactoryView) => `/suppliers/${factory.supplierId}/factories/${factory.id}`;

async function response(path: string, body?: unknown, account: "operator" | "readonly" = "operator", origin?: string) {
  const { access_token: token } = await identityControl("token", { account });
  return fetch(`${base}/v1/${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error",
    headers: { authorization: `Bearer ${token}`, ...(origin ? { origin } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
}
async function api(path: string, body?: unknown) {
  const value = await response(path, body); expect(value.status, `Synthetic factory fixture ${path}`).toBe(body === undefined ? 200 : 201);
  return value.json() as Promise<unknown>;
}
async function seed(label: string) {
  const supplier = await api("sourcing/suppliers", { name: `Synthetic authority supplier ${label}`, kind: "manual", regionCode: "CN", settlementCurrency: "CNY", profile: syntheticSupplierProfile }) as { id: string };
  const oldAddress = `Synthetic original private address ${label} ${"合成地址".repeat(18)}`;
  const originalInput = { supplierId: supplier.id, code: `AUTH-${randomUUID().toUpperCase()}`, profile: { ...syntheticFactoryProfile(`Synthetic authority factory ${label}`),
    productionAddress: { ...syntheticFactoryProfile().productionAddress!, street: oldAddress }, notes: `Synthetic private note ${label}` }, idempotencyKey: randomUUID() };
  const first = FactoryViewSchema.parse(await api("sourcing/factories", originalInput));
  const capabilityInput = { profile: { ...syntheticFactoryCapability("other"), name: `Synthetic private capability ${label}`, specifications: `Synthetic private specification ${label}` }, idempotencyKey: randomUUID() };
  const capability = FactoryCapabilityViewSchema.parse(await api(`sourcing/factories/${first.id}/capabilities`, capabilityInput));
  const revisionInput = { expectedVersion: 1, profile: { ...first.profile, productionAddress: { ...first.profile.productionAddress!, street: `Synthetic current private address ${label}` } }, idempotencyKey: randomUUID() };
  const factory = FactoryViewSchema.parse(await api(`sourcing/factories/${first.id}/revisions`, revisionInput));
  return { supplier, factory, first, capability, originalInput, revisionInput, capabilityInput, oldAddress };
}
type Fixture = Awaited<ReturnType<typeof seed>>;
async function savedRole() {
  const actor = actors().readonly, database = connectDatabase();
  try {
    const [row] = await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" }, tx =>
      tx.select({ permissions: roles.permissions, dataScope: roles.dataScope }).from(roles).where(eq(roles.id, actor.roleId)));
    if (!row || !["self", "team", "tenant"].includes(row.dataScope)) throw new Error("Synthetic factory role is missing or invalid");
    return { permissions: [...row.permissions], dataScope: row.dataScope as "self" | "team" | "tenant" };
  } finally { await database.client.end(); }
}
async function setRole(value: Awaited<ReturnType<typeof savedRole>>) {
  const actor = actors().readonly, database = connectDatabase();
  try {
    const changed = await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" }, tx =>
      tx.update(roles).set(value).where(eq(roles.id, actor.roleId)).returning({ id: roles.id }));
    expect(changed).toHaveLength(1);
  } finally { await database.client.end(); }
}
const grant = (original: Awaited<ReturnType<typeof savedRole>>, permissions: string[], dataScope: "self" | "tenant" = "tenant") =>
  setRole({ permissions: [...new Set([...original.permissions.filter(permission => permission !== read && permission !== write), ...permissions])], dataScope });
async function state(f: Fixture) {
  const actor = actors().operator, database = connectDatabase();
  try {
    return await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" }, async tx => ({
      factories: await tx.select().from(fulfillmentFactories).where(eq(fulfillmentFactories.id, f.factory.id)),
      versions: await tx.select().from(fulfillmentFactoryVersions).where(eq(fulfillmentFactoryVersions.factoryId, f.factory.id)).orderBy(asc(fulfillmentFactoryVersions.versionNumber)),
      capabilities: await tx.select().from(factoryCapabilities).where(eq(factoryCapabilities.factoryId, f.factory.id)).orderBy(asc(factoryCapabilities.id)),
      capabilityVersions: await tx.select().from(factoryCapabilityVersions).where(eq(factoryCapabilityVersions.factoryId, f.factory.id)).orderBy(asc(factoryCapabilityVersions.id)),
      audits: await tx.select().from(auditEvents).where(inArray(auditEvents.entityId, [f.factory.id, f.capability.id])).orderBy(asc(auditEvents.id)),
    }));
  } finally { await database.client.end(); }
}
async function ready(page: Page, f: Fixture) {
  const workspace = page.getByRole("region", { name: "工厂资料与生产能力", exact: true });
  await expect(workspace.getByRole("heading", { name: f.factory.profile.name, exact: true })).toBeVisible();
  await expect(workspace).toContainText(f.capability.profile.name);
  await expect(workspace.getByRole("button", { name: "查看版本历史", exact: true })).toBeEnabled();
  return workspace;
}
async function click(page: Page, button: Locator) {
  await button.scrollIntoViewIfNeeded(); await expect(button).toBeInViewport(); await expect(button).toBeEnabled(); await button.click();
}
async function history(page: Page, f: Fixture) {
  await click(page, (await ready(page, f)).getByRole("button", { name: "查看版本历史", exact: true }));
  const region = page.getByRole("region", { name: "工厂版本历史", exact: true });
  await expect(region).toHaveAttribute("aria-busy", "false");
  await expect(region.getByText(`资料 V1 · ${f.factory.profile.name}`, { exact: false })).toBeVisible(); return region;
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const item of await page.locator(".factory-workspace, .record-dialog[open]").all())
    expect(await item.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}
/** Factory reads are real Next server actions. Hold only the single-ID history action, never fabricate its response. */
async function delayHistory(page: Page, f: Fixture, phase: "response" | "request" = "response") {
  const path = routeFor(f.factory), pattern = `**${path}*`;
  let release: (() => void) | undefined; const gate = new Promise<void>(resolve => { release = resolve; });
  let started = false, finished = false, closed = false, failure = false;
  let captured: { status: number; includesOriginalVersion: boolean; includesOldAddress: boolean; denied: boolean } | undefined;
  const handler = async (route: Route) => {
    let args: unknown; try { args = JSON.parse(route.request().postData() ?? "null"); } catch { args = null; }
    if (started || route.request().method() !== "POST" || new URL(route.request().url()).pathname !== path ||
      !Array.isArray(args) || args.length !== 1 || args[0] !== f.factory.id) { await route.continue(); return; }
    started = true;
    try {
      if (phase === "request") await gate;
      const actual = await route.fetch({ timeout: 15_000 }), text = await actual.text();
      captured = { status: actual.status(), includesOriginalVersion: text.includes(f.first.versionId), includesOldAddress: text.includes(f.oldAddress), denied: text.includes('"denied":true') };
      if (phase === "response") await gate;
      try { await route.fulfill({ response: actual }); } catch { if (!route.request().failure()) throw new Error("Synthetic unhandled history response"); }
    } catch { failure = true; } finally { finished = true; }
  };
  await page.route(pattern, handler);
  const unblock = () => { if (!release) throw new Error("Synthetic history gate missing"); release(); };
  return { started: () => started, captured: () => captured, release: unblock,
    async close() {
      if (closed) return; closed = true; unblock();
      try { if (started) await expect.poll(() => finished, { timeout: 15_000 }).toBe(true); }
      finally { await page.unroute(pattern, handler); }
      if (failure) throw new Error("Synthetic factory history gate failed");
    } };
}

test("a personal mixed-scope reader cannot borrow tenant Read for writes and tenant Write remains independently usable", async ({ page }, info) => {
  const original = await savedRole(), f = await seed(createEntityId()); let extra: Awaited<ReturnType<typeof scopedErpRole>> | undefined;
  try {
    await grant(original, [write], "self"); extra = await scopedErpRole([read], "tenant");
    await page.setViewportSize({ width: 1440, height: 1000 }); await loginErp(page, "readonly", routeFor(f.factory));
    const workspace = await ready(page, f);
    await expect(workspace.getByRole("button", { name: "编辑工厂资料", exact: true })).toHaveCount(0);
    await expect(workspace.getByRole("button", { name: "新增产品与工艺能力", exact: true })).toHaveCount(0);
    await expect(workspace.getByRole("button", { name: "编辑能力", exact: true })).toHaveCount(0);
    await expect(workspace.getByRole("link", { name: "管理本工厂的协作授权", exact: true })).toHaveCount(0);
    const current = await response(`sourcing/factories?supplier=${f.supplier.id}`, undefined, "readonly"); expect(current.status).toBe(200);
    expect(FactoryDirectorySchema.parse(await current.json()).access).toEqual({ canRead: true, canWrite: false });
    const before = await state(f), origin = new URL(page.url()).origin;
    const newFactory = { ...f.originalInput, code: `DENIED-${randomUUID().toUpperCase()}`, idempotencyKey: randomUUID() };
    const revisedFactory = { expectedVersion: 2, profile: { ...f.factory.profile, notes: "Synthetic forbidden edit" }, idempotencyKey: randomUUID() };
    const newCapability = { ...f.capabilityInput, idempotencyKey: randomUUID() };
    const revisedCapability = { expectedVersion: 1, profile: { ...f.capability.profile, specifications: "Synthetic forbidden capability" }, idempotencyKey: randomUUID() };
    for (const [path, body] of [["sourcing/factories", newFactory], [`sourcing/factories/${f.factory.id}/revisions`, revisedFactory],
      [`sourcing/factories/${f.factory.id}/capabilities`, newCapability], [`sourcing/factory-capabilities/${f.capability.id}/revisions`, revisedCapability]] as const)
      expect((await response(path, body, "readonly", origin)).status).toBe(403);
    expect(await state(f)).toEqual(before);
    const originalHistory = await history(page, f); await originalHistory.getByText(`资料 V1 · ${f.factory.profile.name}`, { exact: false }).click();
    await expect(originalHistory).toContainText(f.oldAddress); await noOverflow(page);
    await page.screenshot({ path: info.outputPath("factory-authority-reader-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page);
    await page.screenshot({ path: info.outputPath("factory-authority-reader-mobile.png"), fullPage: true });

    await extra.remove(); extra = undefined; await grant(original, [read], "self"); extra = await scopedErpRole([write], "tenant");
    await loginErp(page, "readonly", routeFor(f.factory));
    expect((await response(`sourcing/factories?supplier=${f.supplier.id}`, undefined, "readonly")).status).toBe(403);
    expect((await response(`sourcing/factories/${f.factory.id}/history`, undefined, "readonly")).status).toBe(403);
    await expect(page.getByRole("region", { name: "工厂资料与生产能力", exact: true })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(f.factory.profile.name);
    const created = await response("sourcing/factories", { ...newFactory, code: `WRITER-${randomUUID().toUpperCase()}` }, "readonly", new URL(page.url()).origin);
    expect(created.status).toBe(201); const createdFactory = FactoryViewSchema.parse(await created.json()); expect(createdFactory.versionNumber).toBe(1);
    const revision = await response(`sourcing/factories/${f.factory.id}/revisions`, revisedFactory, "readonly", new URL(page.url()).origin);
    expect(revision.status).toBe(201); expect(FactoryViewSchema.parse(await revision.json())).toMatchObject({ id: f.factory.id, versionNumber: 3 });
    const added = await response(`sourcing/factories/${f.factory.id}/capabilities`, newCapability, "readonly", new URL(page.url()).origin);
    expect(added.status).toBe(201); expect(FactoryCapabilityViewSchema.parse(await added.json()).versionNumber).toBe(1);
    const changed = await response(`sourcing/factory-capabilities/${f.capability.id}/revisions`, revisedCapability, "readonly", new URL(page.url()).origin);
    expect(changed.status).toBe(201); expect(FactoryCapabilityViewSchema.parse(await changed.json())).toMatchObject({ id: f.capability.id, versionNumber: 2 });
    const afterWrite = await state(f), replay = await response(`sourcing/factories/${f.factory.id}/revisions`, revisedFactory, "readonly", new URL(page.url()).origin);
    expect(replay.status).toBe(201); expect(FactoryViewSchema.parse(await replay.json()).versionNumber).toBe(3); expect(await state(f)).toEqual(afterWrite);
  } finally { try { if (extra) await extra.remove(); } finally { await setRole(original); } }
});

test("a real old factory history response cannot refill after closing or navigating to another factory", async ({ page }) => {
  const original = await savedRole(), a = await seed(createEntityId()), b = await seed(createEntityId());
  const gates: Awaited<ReturnType<typeof delayHistory>>[] = [];
  try {
    await grant(original, [read]); await loginErp(page, "readonly", routeFor(a.factory)); await ready(page, a);
    const beforeA = await state(a), beforeB = await state(b), closeGate = await delayHistory(page, a); gates.push(closeGate);
    await click(page, page.getByRole("button", { name: "查看版本历史", exact: true }));
    await expect.poll(() => closeGate.captured(), { timeout: 15_000 }).toEqual({ status: 200, includesOriginalVersion: true, includesOldAddress: true, denied: false });
    await click(page, page.getByRole("button", { name: "关闭版本历史", exact: true }));
    await expect(page.getByRole("region", { name: "工厂版本历史", exact: true })).toHaveCount(0);
    await closeGate.close(); await expect(page.getByRole("button", { name: "查看版本历史", exact: true })).toBeEnabled();
    const reopened = await history(page, a); await reopened.getByText(`资料 V1 · ${a.factory.profile.name}`, { exact: false }).click();
    await expect(reopened).toContainText(a.oldAddress);
    const navigationGate = await delayHistory(page, a); gates.push(navigationGate);
    await click(page, reopened.getByRole("button", { name: "重新读取版本历史", exact: true }));
    await expect.poll(() => navigationGate.captured()?.status, { timeout: 15_000 }).toBe(200);
    // A real document navigation abandons the old in-flight server action. It is
    // distinct from changing a mounted component's props or mutating the DOM.
    await page.goto(routeFor(b.factory)); await ready(page, b); await navigationGate.close();
    await expect(page.locator("body")).not.toContainText(a.factory.profile.name);
    await expect(page.locator("body")).not.toContainText(a.oldAddress);
    await expect(page.getByRole("region", { name: "工厂版本历史", exact: true })).toHaveCount(0);
    const currentHistory = await history(page, b); await currentHistory.getByText(`资料 V1 · ${b.factory.profile.name}`, { exact: false }).click();
    await expect(currentHistory).toContainText(b.oldAddress); await expect(currentHistory).not.toContainText(a.oldAddress);
    expect(await state(a)).toEqual(beforeA); expect(await state(b)).toEqual(beforeB);
  } finally {
    try { for (const gate of gates) await gate.close(); }
    finally { await setRole(original); }
  }
});

test("current membership revocation closes an editor and a pending history scope downgrade clears every private factory field", async ({ page }) => {
  const original = await savedRole(), f = await seed(createEntityId()); const gates: Awaited<ReturnType<typeof delayHistory>>[] = [];
  let extra: Awaited<ReturnType<typeof scopedErpRole>> | undefined;
  try {
    await grant(original, [read, write]); await loginErp(page, "readonly", routeFor(f.factory)); const workspace = await ready(page, f);
    await click(page, workspace.getByRole("button", { name: "编辑工厂资料", exact: true }));
    const editor = page.getByRole("dialog", { name: "编辑工厂", exact: true }), secret = `Synthetic unsaved private edit ${createEntityId()}`;
    await expect(editor.locator("fieldset.record-fields")).toBeEnabled(); await editor.getByLabel("工厂备注", { exact: true }).fill(secret);
    const before = await state(f); await grant(original, [read]);
    await click(page, editor.getByRole("button", { name: "保存工厂", exact: true }));
    await expect(editor).toHaveCount(0); await expect(page.getByRole("button", { name: "编辑工厂资料", exact: true })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(secret); expect(await state(f)).toEqual(before);
    expect((await response(`sourcing/factories/${f.factory.id}/revisions`, { expectedVersion: 2, profile: f.factory.profile, idempotencyKey: randomUUID() }, "readonly", new URL(page.url()).origin)).status).toBe(403);

    await grant(original, [read, write]); await loginErp(page, "readonly", routeFor(f.factory)); await ready(page, f); await history(page, f);
    const pending = await delayHistory(page, f, "request"); gates.push(pending);
    await click(page, page.getByRole("button", { name: "重新读取版本历史", exact: true }));
    await expect.poll(pending.started, { timeout: 15_000 }).toBe(true);
    // The history read is pending at the real request boundary. Preserve tenant
    // Write while reducing only Read; this is a scope denial, not global logout.
    await grant(original, [read], "self"); extra = await scopedErpRole([write], "tenant");
    expect((await response(`sourcing/factories/${f.factory.id}/history`, undefined, "readonly")).status).toBe(403);
    pending.release(); await pending.close();
    await expect(page.getByRole("heading", { name: "工厂详情", exact: true })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(f.factory.profile.name);
    await expect(page.locator("body")).not.toContainText(f.factory.profile.productionAddress!.street);
    await expect(page.locator("body")).not.toContainText(f.capability.profile.name);
    await expect(page.getByRole("region", { name: "工厂版本历史", exact: true })).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await state(f)).toEqual(before);
    const denied = await response(`sourcing/factories?supplier=${f.supplier.id}`, undefined, "readonly"); expect(denied.status).toBe(403);
    // The underlying immutable records still exist for a currently authorized reader.
    const retained = FactoryHistorySchema.parse(await api(`sourcing/factories/${f.factory.id}/history`));
    expect(retained.factories.map(row => row.versionId)).toEqual([f.first.versionId, f.factory.versionId]);
  } finally {
    try { for (const gate of gates) await gate.close(); }
    finally { try { if (extra) await extra.remove(); } finally { await setRole(original); } }
  }
});
