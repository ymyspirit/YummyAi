import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type Locator, type TestInfo, type Request } from "@playwright/test";
import { z } from "zod";
import { Permission } from "@yummyai/authz";
import { ErpSessionViewSchema } from "@yummyai/contracts/auth/session";
import { AgentNativeV3ViewSchema } from "@yummyai/contracts/ai/agent-native-v3";
import { verifyAgentNativeV3Transport } from "@yummyai/contracts/ai/agent-native-v3-transport";
import { CreatePublicationPreviewInputSchema, PublicationPreviewRequestViewSchema, PublicationPreviewReceiptSchema, type PublicationPreviewRequestView } from "@yummyai/contracts/marketplace/publication-preview";
import { requirePublicationNodePreviewEnvironment } from "../../../tools/testing/publication-node-preview-environment.mjs";
import { PUBLICATION_PREVIEW_INTENT_PREFIX, PublicationPreviewIntentSchema } from "../src/features/marketplaces/publication-preview-intent";
import { loginErp } from "./erp-identity-fixture";
import { observePublicationPreview } from "./publication-node-preview-network.test-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url)), isolated = requirePublicationNodePreviewEnvironment(process.env, "current", true);
const Id = z.uuidv7(), Seed = z.object({ groupId: Id, modelId: Id, actorId: Id, tenantId: Id, nodeId: Id,
  source: z.object({ listingId: Id, versionId: Id, variantSkuId: Id, assetId: Id, supplementalAssetId: Id, spuId: Id, planId: Id, accountId: Id,
    title: z.string(), sku: z.string(), sellerId: z.string(), attributes: z.record(z.string(), z.unknown()) }).strict() }).strict();
type Fixture = Awaited<ReturnType<typeof fixture>>;
const panel = (page: Page) => page.getByRole("region", { name: "Amazon 节点校验预览", exact: true });
const detail = (page: Page) => page.getByRole("region", { name: "原发布预览详情", exact: true });
function latch() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
async function fixture() {
  const config = z.object({ nonce: z.literal(isolated.nonce), pid: z.int().positive(), origin: z.string().url(), key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()
    .parse(JSON.parse(await readFile(resolve(root, "tmp/publication-node-preview-20261022-a6f4c2d9/qa", "browser-control-" + isolated.nonce + ".json"), "utf8")));
  const url = new URL(config.origin); if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/" || !url.port || url.search || url.hash) throw new Error("publication_preview_control_origin_invalid");
  async function call(input: unknown) { const response = await fetch(config.origin, { method: "POST", headers: { "content-type": "application/json", "x-fixture-control": config.key },
    body: JSON.stringify(input), redirect: "error", signal: AbortSignal.timeout(90_000) });
    expect(response.status, "Controlled fixture must complete its original owner action").toBe(200); return await response.json() as unknown;
  }
  const seed = Seed.parse(await call({ operation: "seed" })); let closed = false;
  return { seed, call: (operation: string, extra: object = {}) => call({ operation, groupId: seed.groupId, ...extra }),
    async close() { if (closed) return; closed = true;
      expect(z.object({ originalAuthorizationRevoked: z.literal(true), childExited: z.literal(true), noSecretOutput: z.literal(true), ownedNativeRuns: z.int().nonnegative() }).strict()
        .parse(await call({ operation: "close", groupId: seed.groupId }))).toMatchObject({ originalAuthorizationRevoked: true, childExited: true });
    } };
}
async function picture(page: Page, info: TestInfo, name: string, target: Locator) {
  await target.scrollIntoViewIfNeeded(); await expect(target).toBeInViewport();
  await expect.poll(() => target.evaluate(element => {
    for (let current: Element | null = element; current; current = current.parentElement) if (Number(getComputedStyle(current).opacity) !== 1) return false;
    return element.getAnimations({ subtree: true }).every(animation => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity);
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const path = info.outputPath(name + ".png"); await page.screenshot({ path, fullPage: false }); await info.attach(name, { path, contentType: "image/png" });
}
async function readPreview(page: Page, id: string, seen: Awaited<ReturnType<typeof observePublicationPreview>>) {
  const authority = await seen.currentAuthority(), response = await page.request.get("/api/erp-publication-preview/requests/" + id,
    { headers: { "x-yummyai-context-authority": authority.value } });
  expect(response.status()).toBe(200); expect(response.headers()["x-yummyai-context-authority"]).toBe(authority.value);
  const value = PublicationPreviewRequestViewSchema.parse(await response.json()); expect(value.request.id).toBe(id); return value;
}
async function choosePreview(page: Page, f: Fixture) {
  const source = f.seed.source; await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole("combobox", { name: "原批准 SKU", exact: true })).toBeEnabled();
  await panel(page).getByRole("combobox", { name: "原批准 SKU", exact: true }).selectOption(source.variantSkuId);
  await expect(panel(page).getByRole("combobox", { name: "原店铺与站点", exact: true })).toBeEnabled();
  await panel(page).getByRole("combobox", { name: "原店铺与站点", exact: true }).selectOption(source.accountId + ":ATVPDKIKX0DER");
  await expect(panel(page).getByRole("button", { name: "核对这份原预览", exact: true })).toBeEnabled();
  await panel(page).getByRole("button", { name: "核对这份原预览", exact: true }).click();
  const review = panel(page).getByRole("region", { name: "固定原发布预览", exact: true }); await expect(review).toBeVisible();
  await expect(review).toContainText(source.versionId); await expect(review).toContainText(f.seed.nodeId);
  await review.getByRole("checkbox", { name: "已核对原店铺 原批准版本与节点 只保存校验预览", exact: true }).check();
  return review;
}
async function nativeSource(page: Page, f: Fixture, seen: Awaited<ReturnType<typeof observePublicationPreview>>) {
  const source = f.seed.source, native = page.getByRole("region", { name: "十二类原生工具模型任务", exact: true });
  await expect(native).toBeVisible(); const form = native.getByRole("form", { name: "启动十二类原生工具模型任务", exact: true });
  await form.getByRole("textbox", { name: "本次任务目标", exact: true }).fill("Read the operator selected original Listing and retain its exact version for separate preview review");
  await form.getByRole("combobox", { name: "本次原生任务模型", exact: true }).selectOption(f.seed.modelId);
  await form.getByRole("textbox", { name: "美元费用上限", exact: true }).fill("0.1");
  await form.getByRole("combobox", { name: "选择本次读取工具", exact: true }).selectOption("listing.version");
  const choice = form.getByRole("combobox", { name: "选择原业务对象", exact: true }); await expect(choice).toBeEnabled();
  await choice.selectOption(source.listingId); await seen.originalListingSelected(); await form.getByRole("button", { name: "加入本次固定读取范围", exact: true }).click();
  const created = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent-native-v3/runs")
    .then(async response => ({ status: response.status(), body: AgentNativeV3ViewSchema.parse(await response.json()) }));
  await form.getByRole("button", { name: "启动新的付费原生工具任务", exact: true }).click(); const original = await created; expect(original.status).toBe(201);
  await f.call("native", { runId: original.body.id });
  const person = await seen.currentAuthority(), response = await page.request.get("/api/agent-native-v3/runs/" + original.body.id,
    { headers: { "x-yummyai-context-authority": person.raw } });
  expect(response.status(), JSON.stringify({ status: response.status(), authorityFormat: "original_erp_session_json",
    responseAuthorityMatches: response.headers()["x-yummyai-context-authority"] === person.raw })).toBe(200);
  expect(response.headers()["x-yummyai-context-authority"] === person.raw).toBe(true);
  const value = AgentNativeV3ViewSchema.parse(await response.json()); expect(value.contextAuthority === person.raw).toBe(true); await verifyAgentNativeV3Transport(value);
  expect(value.status, JSON.stringify({ status: value.status, errorCode: value.errorCode })).toBe("completed"); expect(value.cost.modelTurns).toBe(3);
  expect(Number(value.cost.knownCostUsd)).toBe(0); expect(value.items).toEqual([]);
  expect(value.observations[0]?.tool).toBe("listing.version"); expect(value.observations[0]?.results[0]?.dataChecksum).toMatch(/^[a-f0-9]{64}$/);
  await native.getByRole("textbox", { name: "十二类工具任务 ID", exact: true }).fill(value.id);
  await native.getByRole("button", { name: "按原 ID 读取任务", exact: true }).click();
  await expect(page.getByRole("region", { name: "刊登原版本事实", exact: true })).toContainText(source.title);
  const link = page.getByRole("region", { name: "刊登原版本事实", exact: true }).getByRole("link", { name: "核对原刊登版本与发布预览", exact: true });
  const href = new URL((await link.getAttribute("href"))!, "http://localhost:3130"); expect(href.pathname).toBe("/listings/" + source.listingId);
  expect(href.searchParams.get("listingVersionId")).toBe(source.versionId); expect(href.searchParams.get("tab")).toBe("Publish");
  const back = new URL(href.searchParams.get("returnTo")!, "http://localhost:3130"); expect(back.pathname).toBe("/ai-tasks"); expect(back.searchParams.get("agentNativeV3")).toBe(value.id);
  await seen.followOriginalLink(link, { kind: "source", runId: value.id, versionId: source.versionId });
  const returnLink = page.getByRole("link", { name: "返回来源页面继续处理", exact: true }); await expect(returnLink).toHaveAttribute("href", back.pathname + back.search);
  await seen.registerOriginalLink(returnLink, { kind: "return", runId: value.id, versionId: source.versionId });
  return { run: value, returnTo: back.pathname + back.search };
}
async function finalProof(info: TestInfo, seen: Awaited<ReturnType<typeof observePublicationPreview>>, evidence: object, primary: unknown, f: Fixture) {
  const failures: unknown[] = []; if (primary) failures.push(primary);
  let networkFailed = false, cleanupFailed = false;
  try { seen.check(); } catch (error) { networkFailed = true; failures.push(error); }
  try { await f.close(); } catch (error) { cleanupFailed = true; failures.push(error); }
  const path = info.outputPath("publication-node-preview-proof.json");
  await writeFile(path, JSON.stringify({ operation: "a6f4c2d9", ...evidence, primaryFailure: Boolean(primary), network: seen.proof(), networkFailed, cleanupFailed }));
  await info.attach("publication-node-preview-proof", { path, contentType: "application/json" });
  if (failures.length === 1) throw failures[0]; if (failures.length > 1) throw new AggregateError(failures, "Publication preview browser body or strict verification failed");
}

test.describe("personal exact Publication preview through original Agent source and real node", () => {
  test.setTimeout(240_000);
  test("follows the actual V3 Listing source and recovers the original lost201 through GET before real node preview at1440and390", async ({ page }, info) => {
    const f = await fixture(), seen = await observePublicationPreview(page, f.seed.source.listingId), proof: Record<string, unknown> = {}; let primary: unknown;
    let businessPosts = 0;
    page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/erp-publication-preview/requests") businessPosts++; });
    try {
      await page.setViewportSize({ width: 1440, height: 960 });
      await seen.control("login_and_fill", async () => { await loginErp(page, "operator", "/ai-tasks"); const identity = await seen.currentAuthority();
        expect(identity.session).toMatchObject({ userId: f.seed.actorId, tenantId: f.seed.tenantId }); await seen.stable(); });
      const original = await seen.control("open_original_source", async () => { const value = await nativeSource(page, f, seen); await seen.stable(); return value; });
      await choosePreview(page, f); const before = await f.call("snapshot"), entered = latch(); let stored: PublicationPreviewRequestView | undefined;
      await page.route("**/api/erp-publication-preview/requests", async route => {
        const request = route.request(); expect(request.method()).toBe("POST"); const input = CreatePublicationPreviewInputSchema.parse(request.postDataJSON());
        expect(input.listingVersionId).toBe(f.seed.source.versionId); const response = await route.fetch(); expect(response.status()).toBe(201);
        stored = PublicationPreviewRequestViewSchema.parse(await response.json()); expect(stored.request.listingVersionId).toBe(input.listingVersionId);
        expect(stored.intent?.requestKey).toBe(input.requestKey); expect(stored.intent?.requestChecksum).toBe(input.requestChecksum);
        seen.originalLoss(request); entered.release(); await route.abort("failed");
      }, { times: 1 });
      await panel(page).getByRole("region", { name: "固定原发布预览", exact: true }).getByRole("button", { name: "保存原节点预览", exact: true }).click(); await entered.promise;
      await expect(panel(page).getByRole("region", { name: "本人原发布预览恢复", exact: true })).toBeVisible();
      const id = stored!.request.id; proof.originalRequestId = id; proof.nodeExecutionId = stored!.execution!.id;
      await seen.control("reload_original", async () => { await page.reload(); await expect(panel(page).getByRole("region", { name: "本人原发布预览恢复", exact: true })).toBeVisible();
        await seen.registerOriginalLink(page.getByRole("link", { name: "返回来源页面继续处理", exact: true }), { kind: "return", runId: original.run.id, versionId: f.seed.source.versionId });
        await seen.currentAuthority(); await seen.stable(); });
      await expect(panel(page).getByRole("button", { name: "核对这份原预览", exact: true })).toBeDisabled();
      const receiptRead = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/erp-publication-preview/receipt")
        .then(async response => ({ status: response.status(), body: PublicationPreviewReceiptSchema.parse(await response.json()) }));
      await panel(page).getByRole("button", { name: "只读取原预览回执", exact: true }).click(); const restored = await receiptRead;
      expect(restored.status).toBe(200); expect(restored.body.request?.request.id).toBe(id); await expect(detail(page)).toContainText(id);
      expect(businessPosts).toBe(1);
      expect((await readPreview(page, id, seen)).request.current.status).toBe("queued");
      const marks = await page.evaluate(prefix => Object.keys(sessionStorage).filter(key => key.startsWith(prefix)).map(key => JSON.parse(sessionStorage.getItem(key)!)), PUBLICATION_PREVIEW_INTENT_PREFIX);
      expect(marks).toHaveLength(1); const marker = PublicationPreviewIntentSchema.parse(marks[0]); expect(marker.requestId).toBe(id); expect(marker.target.listingVersionId).toBe(f.seed.source.versionId);
      await f.call("work"); await expect.poll(async () => (await readPreview(page, id, seen)).execution?.state, { timeout: 45_000 }).toBe("succeeded");
      await seen.control("refresh_original", async () => { await detail(page).getByRole("button", { name: "重新读取原预览", exact: true }).click();
        await expect(detail(page).getByRole("heading", { name: "校验通过 未发布", exact: true })).toBeVisible(); await seen.stable(); });
      const history = detail(page).locator("details").filter({ has: page.locator("summary").filter({ hasText: /^原发布事件历史/ }) });
      await history.locator("summary").click();
      await history.getByRole("button", { name: "读取原发布事件", exact: true }).click();
      await expect(history.getByRole("region", { name: "原发布事件 2", exact: true })).toContainText("校验通过 未发布");
      await picture(page, info, "preview-desktop", detail(page).getByRole("heading", { name: "校验通过 未发布", exact: true }));
      await page.setViewportSize({ width: 390, height: 844 }); await picture(page, info, "preview-mobile", detail(page).getByRole("heading", { name: "校验通过 未发布", exact: true }));
      const final = z.object({ business: z.object({ paidUsd: z.string(), submissions: z.literal(0), listingSyncs: z.literal(0) }), modelCalls: z.literal(3),
        counts: z.record(z.string(), z.number()), requests: z.array(z.object({ id: Id, listingVersionId: Id })), snapshots: z.array(z.unknown()) }).passthrough().parse(await f.call("snapshot"));
      const initial = z.object({ counts: z.record(z.string(), z.number()) }).passthrough().parse(before);
      expect(final.requests).toHaveLength(1); expect(Number(final.business.paidUsd)).toBe(0); expect(final.snapshots).toHaveLength(1);
      expect((final.counts.amazon_lwa ?? 0) - (initial.counts.amazon_lwa ?? 0)).toBe(1); expect((final.counts.amazon_listing_validation_preview ?? 0) - (initial.counts.amazon_listing_validation_preview ?? 0)).toBe(1);
      expect(businessPosts).toBe(1);
      await expect(panel(page).getByRole("button", { name: /正式提交|继续发布/ })).toHaveCount(0);
      const back = page.getByRole("link", { name: "返回来源页面继续处理", exact: true }); await expect(back).toHaveAttribute("href", original.returnTo);
      await seen.control("open_original_source", async () => { await seen.followOriginalLink(back, { kind: "return", runId: original.run.id, versionId: f.seed.source.versionId });
        await expect(page).toHaveURL(url => url.searchParams.get("agentNativeV3") === original.run.id); await seen.currentAuthority(); await seen.stable(); });
      proof.business = final.business; proof.businessPosts = businessPosts; proof.modelCalls = final.modelCalls; proof.previewPhysicalHttp = 2; proof.originalVersion = f.seed.source.versionId;
    } catch (error) { primary = error; }
    await finalProof(info, seen, proof, primary, f);
  });

  test("blocks unreliable storage and clears a real late original preview after actual personal permission withdrawal", async ({ page }, info) => {
    const f = await fixture(), seen = await observePublicationPreview(page, f.seed.source.listingId), proof: Record<string, unknown> = {}; let primary: unknown;
    const release = latch(); let pending: Request | undefined, returned = false;
    try {
      const target = "/listings/" + f.seed.source.listingId + "?" + new URLSearchParams({ listingVersionId: f.seed.source.versionId, tab: "Publish" });
      await seen.control("login_and_fill", async () => { await loginErp(page, "operator", target); await seen.currentAuthority(); await seen.stable(); });
      await choosePreview(page, f);
      await page.evaluate(prefix => { const original = Storage.prototype.setItem; Object.defineProperty(window, "__restorePreviewStorage", { configurable: true, value: () => { Storage.prototype.setItem = original; } });
        Storage.prototype.setItem = function (key, value) { if (key.startsWith(prefix)) throw new DOMException("Synthetic owned storage unavailable", "QuotaExceededError"); return Reflect.apply(original, this, [key, value]); }; }, PUBLICATION_PREVIEW_INTENT_PREFIX);
      let posts = 0; page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/erp-publication-preview/requests") posts++; });
      await panel(page).getByRole("region", { name: "固定原发布预览", exact: true }).getByRole("button", { name: "保存原节点预览", exact: true }).click();
      await expect(panel(page).getByRole("alert")).toBeVisible(); expect(posts).toBe(0);
      await page.evaluate(() => (window as unknown as { __restorePreviewStorage(): void }).__restorePreviewStorage());
      await seen.control("reload_original", async () => { await page.reload(); await expect(panel(page)).toBeVisible(); await seen.currentAuthority(); await seen.stable(); });
      await choosePreview(page, f);
      const prepared = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/erp-publication-preview/requests")
        .then(async response => ({ status: response.status(), body: PublicationPreviewRequestViewSchema.parse(await response.json()) }));
      await panel(page).getByRole("region", { name: "固定原发布预览", exact: true }).getByRole("button", { name: "保存原节点预览", exact: true }).click();
      const original = await prepared; expect(original.status).toBe(201); expect(posts).toBe(1); await expect(detail(page)).toContainText(original.body.request.id);
      const before = await f.call("snapshot"), entered = latch(), path = "/api/erp-publication-preview/requests/" + original.body.request.id;
      await page.route("**" + path, async route => {
        pending = route.request(); const response = await route.fetch(); expect(response.status()).toBe(200);
        const body = PublicationPreviewRequestViewSchema.parse(await response.json()); expect(body.request.id).toBe(original.body.request.id);
        expect(body.request.listingVersionId).toBe(f.seed.source.versionId); seen.originalHeld200(pending); seen.held(pending); entered.release();
        await release.promise; try { await route.fulfill({ response }); returned = true; } finally { seen.released(pending); }
      }, { times: 1 });
      await detail(page).getByRole("button", { name: "重新读取原预览", exact: true }).click(); await entered.promise;
      const old = await seen.currentAuthority();
      await seen.control("permission_change", async () => {
        await f.call("rights", { enabled: false }); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect.poll(async () => { const response = await page.request.get("/api/erp-auth/session"); return ErpSessionViewSchema.parse(await response.json()).permissions.includes(Permission.ListingRead); }, { timeout: 20_000 }).toBe(false);
        await seen.permissionDocumentReady();
        const current = await seen.currentAuthority(); expect(current.value).not.toBe(old.value);
        await expect(page.locator("body")).not.toContainText(f.seed.source.title); await expect(detail(page)).toHaveCount(0);
        release.release(); await expect.poll(() => returned, { timeout: 15_000 }).toBe(true);
        await expect(page.locator("body")).not.toContainText(f.seed.source.title); await seen.stable();
        const denied = await page.request.get(path, { headers: { "x-yummyai-context-authority": current.value } }); expect(denied.status()).toBe(403);
        proof.oldAuthority = old.value; proof.currentAuthority = current.value;
      });
      expect(posts).toBe(1); expect(await f.call("snapshot")).toEqual(before);
      await page.setViewportSize({ width: 1440, height: 960 }); await picture(page, info, "withdrawn-desktop", page.getByRole("button", { name: "退出登录", exact: true }));
      await page.setViewportSize({ width: 390, height: 844 }); await picture(page, info, "withdrawn-mobile", page.getByRole("button", { name: "退出登录", exact: true }));
      proof.originalRequestId = original.body.request.id; proof.originalVersion = f.seed.source.versionId; proof.storageFailurePosts = 0;
      proof.totalBusinessPosts = posts; proof.lateOriginal200Returned = returned; proof.privateCleared = true;
    } catch (error) { primary = error; }
    finally { release.release(); }
    await finalProof(info, seen, proof, primary, f);
  });
});
