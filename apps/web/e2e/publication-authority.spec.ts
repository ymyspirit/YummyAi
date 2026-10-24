import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Locator, type Page, type Request, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { Permission } from "@yummyai/authz";
import { PublicationPreviewRequestViewSchema, PublicationPreviewWorkspaceSchema } from "@yummyai/contracts/marketplace/publication-preview";
import { requirePublicationAuthorityEnvironment } from "../../../tools/testing/publication-authority-environment.mjs";
import { loginErp } from "./erp-identity-fixture";
import { observePublicationAuthority } from "./publication-authority-network.test-fixture";

const isolated = requirePublicationAuthorityEnvironment(process.env, true), Id = z.uuidv7(), Digest = z.string().regex(/^[a-f0-9]{64}$/),
  Scenario = z.enum(["listing_self", "store_self", "withdraw_store"]);
const State = z.object({ immutable: z.record(z.string(), z.unknown()), counts: z.record(z.string(), z.number()), publicationCalls: z.int().nonnegative(),
  queuedPosts: z.literal(1), state: z.literal("waiting_node"), person: z.object({ authoritySha256: Digest, permissions: z.array(z.string()),
    permissionScopes: z.record(z.string(), z.enum(["self", "team", "tenant"])).optional() }).strict() }).strict();
const Seed = z.object({ groupId: Id, scenario: Scenario, actorId: Id, tenantId: Id, requestId: Id, requestKey: Id, requestChecksum: Digest,
  source: z.object({ listingId: Id, versionId: Id, accountId: Id, variantSkuId: Id, title: z.string().min(1), storeName: z.string().min(1) }).strict(), initial: State }).strict();
const panel = (page: Page) => page.getByRole("region", { name: "Amazon 节点校验预览", exact: true });
const detail = (page: Page) => page.getByRole("region", { name: "原发布预览详情", exact: true });
function latch() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
async function enteredBeforeDeadline(promise: Promise<void>) {
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([promise, new Promise<never>((_accept, reject) => { timer = setTimeout(() => reject(new Error("publication_authority_browser_held_read_not_observed")), 15_000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function controlConfig() {
  const config = z.object({ nonce: z.literal(isolated.nonce), pid: z.int().positive(), origin: z.string().url(), key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()
    .parse(JSON.parse(await readFile(resolve(isolated.lane, "browser-control-" + isolated.nonce + ".json"), "utf8")));
  const url = new URL(config.origin); if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/" || !url.port || url.search || url.hash || url.username || url.password) throw new Error("publication_authority_control_origin_invalid");
  return config;
}
async function fixture(scenario: z.infer<typeof Scenario>) {
  const config = await controlConfig();
  async function call(input: unknown) {
    const response = await fetch(config.origin, { method: "POST", headers: { "content-type": "application/json", "x-fixture-control": config.key },
      body: JSON.stringify(input), redirect: "error", signal: AbortSignal.timeout(90_000) });
    expect(response.status, "The owned fixture must complete the actual original owner operation").toBe(200); return await response.json() as unknown;
  }
  const seed = Seed.parse(await call({ operation: "seed", scenario })); let closed = false;
  return { seed, call: (operation: "change" | "snapshot") => call({ operation, groupId: seed.groupId }),
    async close() { if (closed) return; closed = true;
      expect(z.object({ restored: z.literal(true), originalAuthorizationRevoked: z.literal(true), childrenExited: z.literal(true),
        queuedPosts: z.literal(1), previewHttpCalls: z.literal(0) }).strict().parse(await call({ operation: "close", groupId: seed.groupId })))
        .toMatchObject({ restored: true, originalAuthorizationRevoked: true, childrenExited: true });
    } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Seen = Awaited<ReturnType<typeof observePublicationAuthority>>;
async function picture(page: Page, info: TestInfo, name: string, target: Locator) {
  await target.scrollIntoViewIfNeeded(); await expect(target).toBeInViewport();
  await expect.poll(() => target.evaluate(element => {
    for (let current: Element | null = element; current; current = current.parentElement) if (Number(getComputedStyle(current).opacity) !== 1) return false;
    return element.getAnimations({ subtree: true }).every(animation => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity);
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const path = info.outputPath(name + ".png"); await page.screenshot({ path, fullPage: false }); await info.attach(name, { path, contentType: "image/png" });
}
async function initiallyReadable(page: Page, f: Fixture, seen: Seen) {
  const source = f.seed.source, target = "/listings/" + source.listingId + "?" + new URLSearchParams({ tab: "Publish", publicationRequestId: f.seed.requestId });
  await seen.control("login_and_fill", async () => { await loginErp(page, "operator", target); await seen.currentAuthority(); await seen.stable(); });
  await expect(panel(page)).toBeVisible(); await expect(detail(page)).toContainText(f.seed.requestId); await expect(panel(page)).toContainText(source.title);
  await expect(panel(page).getByRole("combobox", { name: "原店铺与站点", exact: true })).toContainText(source.storeName);
  const owner = await seen.currentAuthority(); expect(owner.session.userId).toBe(f.seed.actorId); expect(owner.session.tenantId).toBe(f.seed.tenantId);
  expect(owner.value).toBe(f.seed.initial.person.authoritySha256);
  const listing = await page.request.get("/api/listings/" + source.listingId, { headers: { "x-yummyai-context-authority": owner.raw } });
  expect(listing.status()).toBe(200); expect(listing.headers()["x-yummyai-context-authority"]).toBe(owner.raw);
  const workspace = await page.request.get("/api/erp-publication-preview/workspace?" + new URLSearchParams({ listingId: source.listingId, listingVersionId: source.versionId }),
    { headers: { "x-yummyai-context-authority": owner.value } });
  expect(workspace.status()).toBe(200); expect(workspace.headers()["x-yummyai-context-authority"]).toBe(owner.value);
  const value = PublicationPreviewWorkspaceSchema.parse(await workspace.json()); seen.registerWorkspace(value);
  expect(value.listing.id).toBe(source.listingId); expect(value.listing.versionId).toBe(source.versionId);
  const read = await page.request.get("/api/erp-publication-preview/requests/" + f.seed.requestId, { headers: { "x-yummyai-context-authority": owner.value } });
  expect(read.status()).toBe(200); expect(read.headers()["x-yummyai-context-authority"]).toBe(owner.value);
  const original = PublicationPreviewRequestViewSchema.parse(await read.json()); expect(original.intent).toMatchObject({ requestKey: f.seed.requestKey, requestChecksum: f.seed.requestChecksum });
  for (const [path, authority] of [["/api/listings/" + source.listingId, owner.raw], ["/api/erp-publication-preview/requests/" + f.seed.requestId, owner.value]] as const) {
    const response = await page.request.head(path, { headers: { "x-yummyai-context-authority": authority } });
    expect(response.status()).toBe(200); expect(response.headers()["x-yummyai-context-authority"]).toBe(authority); expect((await response.body()).byteLength).toBe(0);
  }
  await expect.poll(() => ["/api/listings/" + source.listingId, "/api/erp-publication-preview/requests/" + f.seed.requestId].every(path => seen.hasSuccessfulHead(path))).toBe(true);
  return owner;
}

async function run(page: Page, info: TestInfo, scenario: z.infer<typeof Scenario>) {
  const f = await fixture(scenario), seen = await observePublicationAuthority(page, { ...f.seed.source, requestId: f.seed.requestId, scenario }),
    release = latch(), entered = latch(), proof: Record<string, unknown> = { operation: "f3c8a2d6", scenario }; let primary: unknown;
  let pending: Request | undefined, old200Returned = false, browserPosts = 0;
  const path = scenario === "listing_self" ? "/api/listings/" + f.seed.source.listingId : "/api/erp-publication-preview/requests/" + f.seed.requestId;
  page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/erp-publication-preview/requests") browserPosts++; });
  try {
    const old = await initiallyReadable(page, f, seen), before = State.parse(await f.call("snapshot"));
    expect(old.session.permissionScopes?.[Permission.ListingRead]).toBe(scenario === "listing_self" ? "self" : "tenant");
    expect(old.session.permissionScopes?.[Permission.StoreRead]).toBe(scenario === "store_self" ? "self" : "tenant");
    await page.route("**" + path, async route => {
      expect(route.request().method()).toBe("GET"); pending = route.request();
      const response = await route.fetch(); expect(response.status()).toBe(200);
      expect(response.headers()["x-yummyai-context-authority"]).toBe(scenario === "listing_self" ? old.raw : old.value);
      const body: unknown = await response.json();
      if (scenario === "listing_self") {
        const value = z.object({ listing: z.object({ id: Id }).passthrough(), version: z.object({ id: Id, content: z.object({ title: z.literal(f.seed.source.title) }).passthrough() }).passthrough() }).passthrough().parse(body);
        expect(value.listing.id).toBe(f.seed.source.listingId); expect(value.version.id).toBe(f.seed.source.versionId);
      } else {
        const value = PublicationPreviewRequestViewSchema.parse(body); expect(value.request.id).toBe(f.seed.requestId); expect(value.request.listingVersionId).toBe(f.seed.source.versionId);
      }
      seen.originalHeld200(pending); seen.held(pending); entered.release(); await release.promise;
      try { await route.fulfill({ response }); old200Returned = true; } finally { seen.released(pending); }
    }, { times: 1 });
    await seen.change(old.value, async () => {
      if (scenario === "listing_self") await page.evaluate(listingId => window.dispatchEvent(new CustomEvent("yummyai.publication-preview-recheck", { detail: { listingId } })), f.seed.source.listingId);
      else await detail(page).getByRole("button", { name: "重新读取原预览", exact: true }).click();
      await enteredBeforeDeadline(entered.promise);
      const change = z.object({ changed: z.literal(true), sameAuthority: z.boolean(), state: State }).strict().parse(await f.call("change"));
      expect(change.sameAuthority).toBe(scenario !== "withdraw_store"); seen.changed(change.state.person.authoritySha256, change.sameAuthority);
      if (scenario === "withdraw_store") {
        expect(change.state.person.permissions).not.toContain(Permission.StoreRead); expect(change.state.person.permissions).toContain(Permission.ListingRead);
        await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await seen.permissionDocumentReady();
        expect((await seen.currentAuthority()).value).not.toBe(old.value);
      } else expect((await seen.currentAuthority()).raw).toBe(old.raw);
      release.release(); await expect.poll(() => old200Returned, { timeout: 15_000 }).toBe(true);
      if (scenario === "listing_self") {
        await expect(page.getByRole("heading", { name: "刊登当前不可读取", exact: true })).toBeVisible();
        await expect(page.locator("body")).not.toContainText(f.seed.source.title); await expect(panel(page)).toHaveCount(0); await expect(detail(page)).toHaveCount(0);
        await expect.poll(() => seen.hasDeniedHead("/api/listings/" + f.seed.source.listingId)).toBe(true);
      } else {
        await expect(page.locator("body")).not.toContainText(f.seed.source.storeName); await expect(detail(page)).toHaveCount(0); await expect(panel(page)).toHaveCount(0);
        if (scenario === "store_self") await expect.poll(() => seen.hasDeniedHead("/api/erp-publication-preview/requests/" + f.seed.requestId)).toBe(true);
        await page.getByRole("button", { name: "Content", exact: true }).click();
        const title = page.getByRole("region", { name: "商品内容", exact: true }).getByRole("textbox", { name: /商品标题/ });
        await expect(title).toHaveValue(f.seed.source.title); await expect(title).toBeEnabled(); expect(await title.evaluate(element => (element as HTMLTextAreaElement).readOnly)).toBe(false);
        await expect(page.getByRole("button", { name: "保存为新版本", exact: true })).toBeVisible();
      }
      const current = await seen.currentAuthority(), denied = await page.request.head(path, { headers: { "x-yummyai-context-authority": scenario === "listing_self" ? current.raw : current.value } });
      expect(denied.status()).toBe(scenario === "listing_self" ? 404 : 403); expect((await denied.body()).byteLength).toBe(0);
      await seen.stable(); proof.oldAuthoritySha256 = old.value; proof.currentAuthoritySha256 = current.value;
    });
    const after = State.parse(await f.call("snapshot")); expect(after.immutable).toEqual(before.immutable); expect(after.counts).toEqual(before.counts);
    expect(after.publicationCalls).toBe(0); expect(after.queuedPosts).toBe(1); expect(browserPosts).toBe(0);
    if (scenario !== "withdraw_store") expect(after.person.authoritySha256).toBe(before.person.authoritySha256);
    for (const [width, height, name] of [[1440, 960, "desktop"], [390, 844, "mobile"]] as const) {
      await page.setViewportSize({ width, height });
      const target = scenario === "listing_self" ? page.getByRole("heading", { name: "刊登当前不可读取", exact: true }) :
        page.getByRole("region", { name: "商品内容", exact: true }).getByRole("textbox", { name: /商品标题/ });
      await picture(page, info, scenario + "-" + name, target);
    }
    Object.assign(proof, { originalRequestId: f.seed.requestId, originalKey: f.seed.requestKey, originalChecksum: f.seed.requestChecksum,
      old200Returned, browserPosts, queuedPosts: after.queuedPosts, publicationHttpCalls: 0, immutableBefore: before.immutable, immutableAfter: after.immutable });
  } catch (error) { primary = error; }
  finally { release.release(); }
  const errors: unknown[] = primary ? [primary] : []; let networkFailed = false, cleanupFailed = false;
  try { await seen.stable(); seen.check(); } catch (error) { networkFailed = true; errors.push(error); }
  const network = seen.proof();
  try { await page.close(); await f.close(); } catch (error) { cleanupFailed = true; errors.push(error); }
  const output = info.outputPath("publication-authority-proof.json");
  await writeFile(output, JSON.stringify({ ...proof, primaryFailure: Boolean(primary), networkFailed, cleanupFailed, network }, null, 2));
  await info.attach("publication-authority-proof", { path: output, contentType: "application/json" });
  if (errors.length) throw new AggregateError(errors, "Publication authority browser acceptance failed");
}

test("clears the whole private Listing after a real same-session self-owner change and rejects the held old200", async ({ page }, info) => run(page, info, "listing_self"));
test("clears only private store preview after a real same-session store-owner change and retains legal Listing editing", async ({ page }, info) => run(page, info, "store_self"));
test("withdraws only StoreRead and discards a held old200 while retaining ListingRead and legal Listing editing", async ({ page }, info) => run(page, info, "withdraw_store"));

// Root runs each selected leaf in its own invocation, so an afterAll shutdown never
// removes the shared API from a later worker after a preceding leaf failed.
// eslint-disable-next-line no-empty-pattern -- This shutdown hook intentionally requests no browser fixtures.
test.afterAll(async ({}, info) => {
  test.setTimeout(90_000);
  const errors: unknown[] = []; let config: Awaited<ReturnType<typeof controlConfig>> | undefined;
  try { config = await controlConfig(); } catch (error) { errors.push(error); }
  if (config) {
    try {
      const response = await fetch(config.origin, { method: "POST", headers: { "content-type": "application/json", "x-fixture-control": config.key },
        body: JSON.stringify({ operation: "shutdown" }), redirect: "error", signal: AbortSignal.timeout(10_000) });
      expect(response.status).toBe(202);
      z.object({ accepted: z.literal(true), nonce: z.literal(isolated.nonce), pid: z.literal(config.pid) }).strict().parse(await response.json());
    } catch (error) { errors.push(error); }
    try {
      const path = resolve(isolated.lane, "browser-api-close-" + isolated.nonce + ".json"); let text: string | null = null;
      await expect.poll(async () => {
        try { text = await readFile(path, "utf8"); return true; }
        catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false; throw error; }
      }, { timeout: 60_000, message: "The owned API must write an actual same-nonce shutdown receipt" }).toBe(true);
      const value = z.object({ nonce: z.literal(isolated.nonce), pid: z.literal(config.pid), roleRestored: z.boolean(), savedRoleDigest: Digest,
        restoredRoleDigest: Digest.nullable(), databaseClosed: z.boolean(), controlClosed: z.boolean(), cleanupFailureCount: z.int().nonnegative(),
        apiClosed: z.boolean(), bootstrapClosed: z.boolean(), providerClosed: z.boolean(), childExits: z.array(z.object({
          command: z.enum(["init", "enroll", "run", "work"]), pid: z.int().positive().nullable(), exited: z.boolean(), forced: z.boolean(), leaked: z.boolean(),
          exitCode: z.int().nullable(), stderrCode: z.string().regex(/^store_node_[a-z_]+$/).nullable() }).strict()).max(100) }).strict().parse(JSON.parse(text!));
      const output = info.outputPath("publication-authority-api-close.json"); await writeFile(output, JSON.stringify(value, null, 2));
      await info.attach("publication-authority-api-close", { path: output, contentType: "application/json" });
      expect(value).toMatchObject({ cleanupFailureCount: 0, roleRestored: true, databaseClosed: true, controlClosed: true, apiClosed: true, bootstrapClosed: true, providerClosed: true });
      expect(value.restoredRoleDigest).toBe(value.savedRoleDigest);
      expect(value.childExits.every(child => child.exited && !child.leaked)).toBe(true);
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Publication authority explicit API shutdown was not fully confirmed");
});
