import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page, type Request, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { Permission } from "@yummyai/authz/permissions";
import { PublicationPreviewWorkspaceSchema } from "@yummyai/contracts/marketplace/publication-preview";
import { PublicationSubmitWorkspaceSchema, PublicationSubmitRequestViewSchema, PublicationSubmitReceiptSchema, PublicationStatusReceiptSchema,
  type PublicationSubmitRequestView } from "@yummyai/contracts/marketplace/publication-submit";
import { requirePublicationNodeSubmitEnvironment } from "../../../tools/testing/publication-node-submit-environment.mjs";
import { PUBLICATION_SUBMIT_INTENT_PREFIX, PublicationSubmitIntentSchema } from "../src/features/marketplaces/publication-submit-intent";
import { loginErp } from "./erp-identity-fixture";
import { observePublicationSubmit } from "./publication-node-submit-network.test-fixture";

const isolated = requirePublicationNodeSubmitEnvironment(process.env, "current", true), Id = z.uuidv7(), Digest = z.string().regex(/^[a-f0-9]{64}$/),
  sha = (value: string) => createHash("sha256").update(value).digest("hex"), prefix = "/api/erp-publication-submit";
const Source = z.object({ listingId: Id, versionId: Id, accountId: Id, variantSkuId: Id, title: z.string(), sku: z.string() }).passthrough();
const Person = z.object({ actorId: Id, tenantId: Id, authoritySha256: Digest }).strict();
const Snapshot = z.object({ person: Person, business: z.object({ paid: z.literal(0), listingSyncs: z.literal(0) }).strict(), counts: z.record(z.string(), z.int().nonnegative()), centralRefreshes: z.int().nonnegative(),
  requests: z.array(z.object({ id: Id, parentRequestId: Id.nullable(), action: z.string(), listingVersionId: Id, payloadChecksum: Digest, sha256: Digest }).strict()),
  intents: z.array(z.object({ requestId: Id, route: z.string(), sha256: Digest }).strict()),
  operations: z.array(z.object({ id: Id, requestId: Id, kind: z.enum(["submit", "status"]), requestKey: Id, requestChecksum: Digest, executionId: Id, sha256: Digest }).strict()),
  results: z.array(z.object({ operationId: Id, requestId: Id, adoptedAsRequestStatus: z.boolean(), sha256: Digest }).strict()),
  events: z.array(z.object({ id: Id, requestId: Id, sequence: z.int().positive(), status: z.string(), sha256: Digest }).strict()),
  child: z.object({ pid: z.int().positive().nullable(), exited: z.boolean(), leaked: z.boolean(), states: z.array(z.unknown()), stderrCode: z.string().nullable() }).strict().nullable() }).strict();
const Seed = z.object({ groupId: Id, scenario: z.enum(["explicit_submit_status", "lost_submit_recovery"]), actorId: Id, tenantId: Id, accountId: Id, nodeId: Id,
  source: Source, previewId: Id, initial: Snapshot }).strict();
const formal = (page: Page) => page.getByRole("region", { name: "Amazon 正式提交", exact: true });
const original = (page: Page) => formal(page).getByRole("region", { name: "原正式提交回执", exact: true });
const recovery = (page: Page) => formal(page).getByRole("region", { name: "本人原正式操作恢复", exact: true });
let compiled: { id: string; buildId: string; manifestSha256: string } | undefined;
test.beforeAll(async () => {
  const cwd = process.env.KNOWLEDGE_BROWSER_CWD, root = fileURLToPath(new URL("../../../", import.meta.url));
  if (!cwd || !isAbsolute(cwd)) throw new Error("publication_submit_compiled_candidate_missing");
  const directory = resolve(cwd), match = /^\.artifacts\/local-web-releases\/([a-f0-9]{32})\/apps\/web$/.exec(relative(root, directory).replaceAll("\\", "/"));
  if (!match || (await realpath(directory)).toLowerCase() !== directory.toLowerCase()) throw new Error("publication_submit_compiled_candidate_invalid");
  const bytes = await readFile(resolve(directory, "../../manifest.json")), value = z.object({ id: z.literal(match[1]!), status: z.literal("built"),
    scope: z.literal("local-web-runtime"), buildId: z.string().min(1) }).passthrough().parse(JSON.parse(bytes.toString("utf8")));
  expect((await readFile(resolve(directory, ".next/BUILD_ID"), "utf8")).trim()).toBe(value.buildId);
  compiled = { id: value.id, buildId: value.buildId, manifestSha256: createHash("sha256").update(bytes).digest("hex") };
});

async function config() {
  const value = z.object({ nonce: z.literal(isolated.nonce), pid: z.int().positive(), origin: z.url(), key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()
    .parse(JSON.parse(await readFile(resolve(isolated.lane, "browser-control-" + isolated.nonce + ".json"), "utf8")));
  const url = new URL(value.origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("publication_submit_control_origin_invalid");
  return value;
}
async function control(input: unknown, status = 200) {
  const value = await config(), response = await fetch(value.origin, { method: "POST", headers: { "content-type": "application/json", "x-fixture-control": value.key },
    body: JSON.stringify(input), redirect: "error", signal: AbortSignal.timeout(90_000) });
  expect(response.status, "The finite owned control must execute the actual original owner or node CLI").toBe(status); return await response.json() as unknown;
}
async function fixture(scenario: z.infer<typeof Seed>["scenario"]) {
  const seed = Seed.parse(await control({ operation: "seed", scenario })); let closed = false;
  expect(seed.source.accountId).toBe(seed.accountId); expect(seed.initial.person).toMatchObject({ actorId: seed.actorId, tenantId: seed.tenantId });
  return { seed, call: (operation: "work" | "snapshot" | "withdraw", fields: object = {}) => control({ operation, groupId: seed.groupId, ...fields }),
    async close() { if (closed) return; expect(await control({ operation: "close", groupId: seed.groupId })).toEqual({ closed: true, originalAuthorizationRevoked: true, childrenExited: true }); closed = true; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Seen = Awaited<ReturnType<typeof observePublicationSubmit>>;
function deferred() { let done!: () => void, fail!: (error: unknown) => void; const promise = new Promise<void>((resolve, reject) => { done = resolve; fail = reject; });
  void promise.catch(() => {}); return { promise, release: done, reject: fail }; }
function listingUrl(seed: z.infer<typeof Seed>) { return `/listings/${seed.source.listingId}?${new URLSearchParams({ listingVersionId: seed.source.versionId, publicationRequestId: seed.previewId, tab: "Publish" })}`; }
function isResponse(value: { url(): string; request(): Request; status(): number }, path: string, method = "GET", status = 200) {
  const url = new URL(value.url()); return url.origin === "http://localhost:3130" && url.pathname === path && value.request().method() === method && value.status() === status;
}
async function login(page: Page, f: Fixture, seen: Seen) {
  await seen.control("login_and_fill", async () => {
    const workspace = page.waitForResponse(response => isResponse(response, "/api/erp-publication-preview/workspace")).then(async response => {
      const value = PublicationPreviewWorkspaceSchema.parse(await response.json()); seen.registerWorkspace(value); expect(value.listing.versionId).toBe(f.seed.source.versionId); return value;
    });
    await loginErp(page, "operator", listingUrl(f.seed)); await workspace;
    await expect(page.getByRole("region", { name: "原发布预览详情", exact: true }).getByRole("heading", { name: "校验通过 未发布", exact: true })).toBeVisible();
    const current = await seen.currentAuthority(); expect(current.session.userId).toBe(f.seed.actorId); expect(current.session.tenantId).toBe(f.seed.tenantId);
    expect(current.value).toBe(f.seed.initial.person.authoritySha256); await seen.stable();
  });
}
async function openFormal(page: Page, f: Fixture, seen: Seen) {
  const summary = formal(page).locator("summary").filter({ hasText: "正式提交本次原预览" }).first(); await expect(summary).toBeVisible();
  await expect(formal(page).locator("details.psu-workspace")).not.toHaveAttribute("open", "");
  const pending = page.waitForResponse(response => isResponse(response, prefix + "/workspace") && new URL(response.url()).searchParams.get("previewRequestId") === f.seed.previewId)
    .then(async response => { const value = PublicationSubmitWorkspaceSchema.parse(await response.json()); expect(value.context.authority).toBe(response.headers()["x-yummyai-context-authority"]);
      expect(value.context).toMatchObject({ actorId: f.seed.actorId, tenantId: f.seed.tenantId }); expect(value.preview.request.id).toBe(f.seed.previewId); return value; });
  await seen.control("refresh_original", async () => { await summary.click(); await pending; await seen.currentAuthority(); await seen.stable(); });
}
async function reviewSubmit(page: Page) {
  await formal(page).getByRole("button", { name: "核对正式提交完整替换", exact: true }).click();
  const review = formal(page).getByRole("region", { name: "固定原正式提交核对", exact: true }), submit = review.getByRole("button", { name: "确认正式提交至 Amazon", exact: true });
  await expect(review).toBeVisible(); await expect(review).toContainText("完整替换"); await expect(submit).toBeDisabled();
  await review.getByRole("checkbox", { name: "已核对原店铺 SKU 与版本 明确同意完整替换并正式提交", exact: true }).check();
  await expect(submit).toBeEnabled(); return submit;
}
async function refresh(page: Page, id: string, seen: Seen) {
  const pending = page.waitForResponse(response => isResponse(response, prefix + "/requests/" + id)).then(async response => seen.acceptedRead(response.request(), await response.json()));
  await original(page).getByRole("button", { name: "重新读取原正式请求", exact: true }).click(); const value = await pending; await seen.stable(); return value;
}
async function work(f: Fixture, executionId: string) {
  const value = z.object({ terminal: z.object({ id: z.literal(executionId), state: z.literal("succeeded"), phase: z.string(), errorCode: z.null(), completionChecksum: Digest }).strict(), snapshot: Snapshot }).strict().parse(await f.call("work", { executionId }));
  expect(value.snapshot.child).toMatchObject({ exited: true, leaked: false }); return value.snapshot;
}
async function markers(page: Page) {
  const entries = await page.evaluate(prefix => Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
    .filter((key): key is string => Boolean(key?.startsWith(prefix))).map(key => ({ key, value: sessionStorage.getItem(key)! })), PUBLICATION_SUBMIT_INTENT_PREFIX);
  return entries.map(entry => ({ value: PublicationSubmitIntentSchema.parse(JSON.parse(entry.value)), sha256: sha(entry.value), text: entry.value }));
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
function providerDelta(before: z.infer<typeof Snapshot>, after: z.infer<typeof Snapshot>, submissions: number, statuses: number) {
  const delta = (kind: string) => (after.counts[kind] ?? 0) - (before.counts[kind] ?? 0);
  expect(delta("amazon_listing_submit")).toBe(submissions); expect(delta("amazon_listing_status")).toBe(statuses); expect(delta("amazon_lwa")).toBe(submissions + statuses);
  expect(Object.entries(after.counts).reduce((sum, [kind, count]) => sum + count - (before.counts[kind] ?? 0), 0)).toBe(2 * (submissions + statuses));
  expect(after.centralRefreshes).toBe(before.centralRefreshes); expect(after.business).toEqual(before.business);
}
async function finish(page: Page, info: TestInfo, f: Fixture | undefined, seen: Seen | undefined, proof: Record<string, unknown>, primary: unknown) {
  const errors: unknown[] = primary ? [primary] : []; let networkFailed = false, cleanupFailed = false;
  try { if (seen) { await seen.stable(); seen.check(); } } catch (error) { errors.push(error); networkFailed = true; }
  const network = seen?.proof();
  try { await page.close(); } catch (error) { errors.push(error); cleanupFailed = true; }
  try { await f?.close(); } catch (error) { errors.push(error); cleanupFailed = true; }
  const path = info.outputPath("publication-node-submit-proof.json"); await writeFile(path, JSON.stringify({ operation: "74c2e8b1", title: info.title,
    groupId: f?.seed.groupId ?? null, compiled, actualPersonalOidc: proof.actualPersonalOidc === true, actualNodeCliAndMtls: proof.actualNodeCliAndMtls === true, providerBoundary: "synthetic_https_after_original_official_policy",
    actualSellerPublication: false, primaryFailure: Boolean(primary), networkFailed, cleanupFailed, ...proof, network }, null, 2));
  await info.attach("publication-node-submit-proof", { path, contentType: "application/json" });
  if (errors.length) throw new AggregateError(errors, "publication_node_submit_browser_failed");
}

test("explicit_original_submit_and_status uses the reviewed version once and observes current SKU separately", async ({ page }, info) => {
  let f: Fixture | undefined, seen: Seen | undefined, primary: unknown; const proof: Record<string, unknown> = {};
  const posts: string[] = []; page.on("request", request => { const url = new URL(request.url()); if (url.origin === "http://localhost:3130" && request.method() === "POST" && url.pathname.startsWith(prefix)) posts.push(url.pathname); });
  try {
    f = await fixture("explicit_submit_status"); seen = await observePublicationSubmit(page, { ...f.seed.source, previewId: f.seed.previewId }); await login(page, f, seen); proof.actualPersonalOidc = true;
    expect(posts).toEqual([]); await openFormal(page, f, seen); const submit = await reviewSubmit(page); expect(posts).toEqual([]);
    const saved = page.waitForResponse(response => isResponse(response, prefix + "/requests", "POST", 201)).then(response => seen!.acceptedResponse(response));
    await submit.click(); const created = await saved; await expect(original(page)).toContainText(created.request.id); await seen.stable();
    expect(posts).toEqual([prefix + "/requests"]); expect(created.intent.target.sku).toBe(f.seed.source.sku); expect(created.request.listingVersionId).toBe(f.seed.source.versionId);
    const queued = Snapshot.parse(await f.call("snapshot")); expect(queued.counts).toEqual(f.seed.initial.counts); expect(queued.operations.filter(row => row.kind === "submit")).toHaveLength(1);
    await work(f, created.execution.id); proof.actualNodeCliAndMtls = true; let accepted = await refresh(page, created.request.id, seen);
    expect(accepted.request.current.status).toBe("submission_accepted"); expect(accepted.result?.status).toBe("submission_accepted"); expect(accepted.result?.externalSubmissionId).toBeTruthy();
    await expect(original(page)).toContainText("尚未证明可售"); expect(posts).toHaveLength(1);
    await formal(page).getByRole("button", { name: "核对独立平台状态查询", exact: true }).click();
    const statusReview = formal(page).getByRole("region", { name: "固定原平台状态查询核对", exact: true }), statusSubmit = statusReview.getByRole("button", { name: "确认保存原平台状态查询", exact: true });
    await expect(statusReview).toContainText("按原请求的 SKU 查询平台当前状态"); await expect(statusSubmit).toBeDisabled();
    await statusReview.getByRole("checkbox", { name: "已核对原请求 明确读取平台当前状态 不重新提交", exact: true }).check();
    const statusSaved = page.waitForResponse(response => isResponse(response, prefix + "/requests/" + created.request.id + "/status", "POST", 201)).then(async response => {
      expect(response.headers()["x-yummyai-context-authority"]).toBe(response.request().headers()["x-yummyai-context-authority"]); return seen!.acceptedStatus(response.request(), await response.json());
    });
    await statusSubmit.click(); const status = await statusSaved; expect(status.target.sourceSubmissionId).toBe(accepted.result!.externalSubmissionId);
    expect(status.target.submissionExecutionId).toBe(created.execution.id); expect(status.target.submissionTargetChecksum).toBe(created.intent.requestChecksum);
    await work(f, status.execution.id); accepted = await refresh(page, created.request.id, seen); expect(accepted.request.current.status).toBe("published");
    const lookup = recovery(page).locator("article").filter({ hasText: "平台状态查询" });
    const read = page.waitForResponse(response => isResponse(response, prefix + "/status-receipt")).then(async response => PublicationStatusReceiptSchema.parse(await response.json()));
    await lookup.getByRole("button", { name: "只读取原操作回执", exact: true }).click(); const receipt = await read;
    expect(receipt).toMatchObject({ found: true, requestKey: status.requestKey, requestChecksum: status.requestChecksum });
    expect(receipt.operation?.id).toBe(status.id); expect(receipt.operation?.result?.status).toBe("published"); expect(receipt.operation?.adoptedAsRequestStatus).toBe(true);
    const observation = formal(page).getByRole("region", { name: "原平台状态观察 " + status.id, exact: true });
    await expect(observation).toContainText("SKU 当前状态观察 不能单独证明本次版本全部内容已生效"); await expect(observation).toContainText("原服务已将此观察采纳为原请求状态");
    const final = Snapshot.parse(await f.call("snapshot")); providerDelta(f.seed.initial, final, 1, 1);
    expect(final.requests.filter(row => row.parentRequestId === f!.seed.previewId && row.action === "amazon_submit")).toHaveLength(1);
    expect(final.requests.find(row => row.id === f!.seed.previewId)).toEqual(f.seed.initial.requests.find(row => row.id === f!.seed.previewId));
    expect(final.requests.find(row => row.id === created.request.id)).toEqual(queued.requests.find(row => row.id === created.request.id));
    expect(final.operations.filter(row => row.requestId === created.request.id).map(row => row.kind).sort()).toEqual(["status", "submit"]);
    expect(final.results.filter(row => row.requestId === created.request.id)).toHaveLength(2); expect(posts).toEqual([prefix + "/requests", prefix + "/requests/" + created.request.id + "/status"]);
    for (const [width, height, name] of [[1440, 960, "desktop"], [390, 844, "mobile"]] as const) { await page.setViewportSize({ width, height }); await picture(page, info, "formal-submit-status-" + name, observation.getByRole("heading", { name: "独立平台状态观察", exact: true })); }
    Object.assign(proof, { originalPreviewId: f.seed.previewId, originalRequestId: created.request.id, originalRequestKey: created.intent.requestKey, originalChecksum: created.intent.requestChecksum,
      originalVersionId: f.seed.source.versionId, statusReadId: status.id, postCount: posts.length, physicalPut: 1, physicalStatusGet: 1, originalPreviewUnchanged: true, business: final.business });
  } catch (error) { primary = error; }
  await finish(page, info, f, seen, proof, primary);
});

test("lost_original_submit_receipt_and_withdrawal restores only the original key and discards a held old200", async ({ page }, info) => {
  let f: Fixture | undefined, seen: Seen | undefined, primary: unknown, stored: PublicationSubmitRequestView | undefined;
  const proof: Record<string, unknown> = {}, entered = deferred(), release = deferred(), done = deferred(); let heldRequest: Request | undefined, delivered = false, cancelled = false, withdrawalObserved = false;
  let posts = 0; page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === prefix + "/requests") posts++; });
  try {
    f = await fixture("lost_submit_recovery"); seen = await observePublicationSubmit(page, { ...f.seed.source, previewId: f.seed.previewId }); await login(page, f, seen); proof.actualPersonalOidc = true; await openFormal(page, f, seen);
    const submit = await reviewSubmit(page), lost = deferred();
    await page.route("**/api/erp-publication-submit/requests", async route => {
      try {
        if (route.request().method() !== "POST" || new URL(route.request().url()).search) throw new Error("publication_submit_loss_transport_wrong_request");
        const response = await route.fetch(); expect(response.status()).toBe(201); stored = PublicationSubmitRequestViewSchema.parse(await response.json());
        seen!.loss(route.request(), stored, response.headers()["x-yummyai-context-authority"]); await route.abort("failed"); lost.release();
      } catch (error) { lost.reject(error); }
    }, { times: 1 });
    await seen.control("refresh_original", async () => { await submit.click(); await lost.promise; await expect(recovery(page)).toBeVisible(); await seen!.stable(); });
    expect(posts).toBe(1); expect(stored).toBeDefined();
    const unknown = await markers(page); expect(unknown).toHaveLength(1); expect(unknown[0]!.value).toMatchObject({ operation: "submit", requestKey: stored!.intent.requestKey, requestChecksum: stored!.intent.requestChecksum, state: "unknown", resultId: null });
    expect(unknown[0]!.text.includes(f.seed.source.sku)).toBe(false); expect(unknown[0]!.text.includes(f.seed.source.title)).toBe(false);
    await seen.control("reload_original", async () => { await page.reload(); await expect(formal(page)).toBeVisible(); await seen!.currentAuthority(); await seen!.stable(); });
    expect((await markers(page))[0]!.sha256).toBe(unknown[0]!.sha256); await openFormal(page, f, seen);
    await expect(formal(page).getByRole("button", { name: "核对正式提交完整替换", exact: true })).toBeDisabled();
    const recovered = page.waitForResponse(response => isResponse(response, prefix + "/receipt")).then(async response => PublicationSubmitReceiptSchema.parse(await response.json()));
    await recovery(page).getByRole("button", { name: "只读取原操作回执", exact: true }).click(); const receipt = await recovered;
    expect(receipt).toMatchObject({ found: true, requestKey: stored!.intent.requestKey, requestChecksum: stored!.intent.requestChecksum }); expect(receipt.request?.request.id).toBe(stored!.request.id);
    await expect(original(page)).toContainText(stored!.request.id); const known = await markers(page); expect(known[0]!.value).toMatchObject({ state: "known", resultId: stored!.request.id, requestKey: stored!.intent.requestKey });
    const beforeWork = Snapshot.parse(await f.call("snapshot")); expect(beforeWork.counts).toEqual(f.seed.initial.counts); expect(beforeWork.operations).toHaveLength(1); expect(posts).toBe(1);
    await work(f, stored!.execution.id); proof.actualNodeCliAndMtls = true; expect((await refresh(page, stored!.request.id, seen)).request.current.status).toBe("submission_accepted");
    const before = Snapshot.parse(await f.call("snapshot")), old = await seen.currentAuthority(); providerDelta(f.seed.initial, before, 1, 0);
    await page.route("**/api/erp-publication-submit/requests/" + stored!.request.id, async route => {
      if (route.request().method() !== "GET" || new URL(route.request().url()).search) { await route.continue(); return; }
      heldRequest = route.request();
      try {
        const response = await route.fetch(); expect(response.status()).toBe(200); const value = PublicationSubmitRequestViewSchema.parse(await response.json());
        expect(value.request.id).toBe(stored!.request.id); expect(response.headers()["x-yummyai-context-authority"]).toBe(old.value); seen!.heldSubmission200(heldRequest, value); entered.release();
        await release.promise;
        if (withdrawalObserved && heldRequest.failure()?.errorText === "net::ERR_ABORTED") cancelled = true;
        else { try { await route.fulfill({ response }); delivered = true; } catch (error) {
          if (!withdrawalObserved || heldRequest.failure()?.errorText !== "net::ERR_ABORTED") throw error; cancelled = true;
        } }
      } catch (error) { entered.reject(error); done.reject(error); }
      finally { seen!.releaseHeld(route.request()); done.release(); }
    }, { times: 1 });
    await seen.change(old.value, async () => {
      await original(page).getByRole("button", { name: "重新读取原正式请求", exact: true }).click(); await entered.promise;
      const changed = z.object({ beforeAuthority: Digest, afterAuthority: Digest, permission: z.literal(Permission.StoreRead) }).strict().parse(await f!.call("withdraw"));
      expect(changed.beforeAuthority).toBe(old.value); expect(changed.afterAuthority).not.toBe(old.value); seen!.changed(changed.afterAuthority, false); withdrawalObserved = true;
      await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await seen!.permissionDocumentReady();
      const current = await seen!.currentAuthority(); expect(current.value).toBe(changed.afterAuthority); expect(current.session.permissions).not.toContain(Permission.StoreRead); expect(current.session.permissions).toContain(Permission.ListingRead);
      release.release(); await done.promise; expect(delivered || cancelled).toBe(true);
      await expect(formal(page)).toHaveCount(0); await expect(page.getByRole("region", { name: "原发布预览详情", exact: true })).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText(stored!.request.id);
      const denied = await page.request.get(prefix + "/requests/" + stored!.request.id, { headers: { "x-yummyai-context-authority": current.value } }); expect(denied.status()).toBe(403);
      await page.getByRole("button", { name: "Content", exact: true }).click(); const title = page.getByRole("region", { name: "商品内容", exact: true }).getByRole("textbox", { name: /商品标题/ });
      await expect(title).toHaveValue(f!.seed.source.title); await seen!.currentAuthority(); await seen!.stable();
      Object.assign(proof, { originalAuthoritySha256: old.value, currentAuthoritySha256: current.value, lateReadReturned: delivered, lateReadCancelled: cancelled, currentObjectReadStatus: 403 });
    });
    const after = Snapshot.parse(await f.call("snapshot"));
    for (const key of ["requests", "intents", "operations", "results", "events", "counts", "business", "centralRefreshes"] as const) expect(after[key]).toEqual(before[key]);
    expect(posts).toBe(1); expect((await markers(page))[0]!.sha256).toBe(known[0]!.sha256);
    for (const [width, height, name] of [[1440, 960, "desktop"], [390, 844, "mobile"]] as const) { await page.setViewportSize({ width, height }); await picture(page, info, "formal-submit-withdrawal-" + name, page.getByRole("region", { name: "商品内容", exact: true }).getByRole("textbox", { name: /商品标题/ })); }
    const logout = await seen.explicitLogout(); expect(logout).toMatchObject({ sessionStatus: 401, markerCount: 0 }); expect(await markers(page)).toEqual([]); expect(posts).toBe(1);
    Object.assign(proof, { originalRequestId: stored!.request.id, originalRequestKey: stored!.intent.requestKey, originalChecksum: stored!.intent.requestChecksum,
      originalVersionId: f.seed.source.versionId, unknownMarkerSha256: unknown[0]!.sha256, knownMarkerSha256: known[0]!.sha256, submitPosts: posts,
      recoveryProviderDelta: 0, physicalPut: 1, physicalStatusGet: 0, business: after.business, logoutMarkersCleared: true, logoutWindowId: logout.windowId });
  } catch (error) { primary = error; }
  finally { release.release(); }
  await finish(page, info, f, seen, proof, primary);
});

// Root may run selected leaves separately. API shutdown is explicit and proven by the
// exact same-nonce/PID receipt; an exit signal is not accepted as successful cleanup.
// eslint-disable-next-line no-empty-pattern -- This finalizer intentionally requests no page fixtures.
test.afterAll(async ({}, info) => {
  test.setTimeout(90_000); const errors: unknown[] = []; let value: Awaited<ReturnType<typeof config>> | undefined, receipt: unknown;
  try { value = await config(); } catch (error) { errors.push(error); }
  if (value) {
    try { z.object({ accepted: z.literal(true), nonce: z.literal(isolated.nonce), pid: z.literal(value.pid) }).strict().parse(await control({ operation: "shutdown" }, 202)); } catch (error) { errors.push(error); }
    try {
      await expect.poll(async () => { try { receipt = JSON.parse(await readFile(resolve(isolated.lane, "browser-api-close-" + isolated.nonce + ".json"), "utf8")); return true; }
        catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false; throw error; } }, { timeout: 60_000 }).toBe(true);
      const closed = z.object({ nonce: z.literal(isolated.nonce), pid: z.literal(value.pid), roleRestored: z.literal(true), savedRoleDigest: Digest, restoredRoleDigest: Digest,
        databaseClosed: z.literal(true), controlClosed: z.literal(true), cleanupFailureCount: z.literal(0), apiClosed: z.literal(true), providerClosed: z.literal(true), bootstrapClosed: z.literal(true),
        // The original CLI also records signal, byte counts, environment key names and
        // finite storage/state diagnostics. Preserve those actual metadata fields;
        // process exit and no-leak assertions remain mandatory for every child.
        childExits: z.array(z.object({ command: z.enum(["init", "enroll", "run", "work"]), pid: z.int().positive().nullable(), exited: z.literal(true), forced: z.boolean(), leaked: z.literal(false),
          exitCode: z.int().nullable(), stderrCode: z.string().nullable() }).passthrough()) }).strict().parse(receipt);
      expect(closed.savedRoleDigest).toBe(closed.restoredRoleDigest); expect(closed.childExits.length).toBeGreaterThan(0);
    } catch (error) { errors.push(error); }
  }
  const path = info.outputPath("publication-node-submit-api-close.json"); await writeFile(path, JSON.stringify({ actualReceipt: receipt ?? null, failed: errors.length > 0 }));
  await info.attach("publication-node-submit-api-close", { path, contentType: "application/json" });
  if (errors.length) throw new AggregateError(errors, "publication_node_submit_actual_api_shutdown_failed");
});
