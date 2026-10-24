import { expect, test, type Locator, type Page, type Request, type TestInfo } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { Permission } from "@yummyai/authz";
import { TenantContextSchema } from "@yummyai/contracts";
import { AgentFulfillmentCallSchema, AgentFulfillmentCandidatesSchema, AgentFulfillmentResultSchema, AgentFulfillmentWorkspaceSchema,
  type AgentFulfillmentKind } from "@yummyai/contracts/ai/agent-fulfillment";
import { verifyAgentFulfillmentResult } from "@yummyai/contracts/ai/agent-fulfillment-transport";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { requireFulfillmentEnvironment } from "../../../tools/testing/require-agent-fulfillment-environment.mjs";
import { actors, loginErp } from "./erp-identity-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url)), sha = (text: string) => createHash("sha256").update(text).digest("hex");
const Id = z.uuidv7(), Seed = z.object({ orderId: Id, lineId: Id, orderNumber: z.string(), expectedSequence: z.number().int().positive(),
  productionIds: z.array(Id).length(6), firstProductionId: Id, firstProductionVersionId: Id, fileChecksum: z.string().length(64), importId: Id,
  inspectionId: Id, shipmentId: Id, logisticsTaskId: Id }).strict();
type Source = z.infer<typeof Seed>;
const State = z.object({ tables: z.record(z.string(), z.object({ count: z.number(), hash: z.string() }).strict()),
  carrier: z.object({ channels: z.number(), quotes: z.number(), creates: z.number(), lookups: z.number(), labels: z.number(), downloads: z.number() }).strict(),
  logisticsEnqueues: z.number(), shipmentEnqueues: z.number() }).strict();
const latch = () => { let release!: () => void; const promise = new Promise<void>(accept => { release = accept; }); return { promise, release }; };
async function bounded<T>(promise: Promise<T>, label: string, timeout = 30_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), timeout); })]); }
  finally { if (timer) clearTimeout(timer); }
}

class FulfillmentChild {
  private readonly child: ChildProcess;
  private readonly waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private readonly ready: Promise<void>;
  private readonly ended: Promise<void>;
  private sequence = 0;
  private closing: Promise<void> | undefined;
  readonly evidence = { pid: null as number | null, closeAcknowledged: false, restored: false, disconnected: false, exited: false, exitCode: null as number | null, signal: null as string | null };
  constructor(private readonly nonce: string) {
    this.child = spawn(process.execPath, ["--import", pathToFileURL(resolve(root, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
      resolve(root, "apps/api/src/ai/agent-fulfillment.test-fixture.ts"), "--agent-fulfillment-browser-child"], { cwd: root, windowsHide: true,
      env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json") }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    this.evidence.pid = this.child.pid ?? null;
    let ready!: () => void, fail!: (error: Error) => void;
    this.ready = new Promise((accept, reject) => { ready = accept; fail = reject; });
    const timer = setTimeout(() => fail(new Error("fulfillment_child_ready_timeout")), 30_000);
    this.ended = new Promise(accept => this.child.once("exit", (code, signal) => {
      clearTimeout(timer); this.evidence.exited = true; this.evidence.exitCode = code; this.evidence.signal = signal;
      fail(new Error("fulfillment_child_exited_before_ready"));
      for (const pending of this.waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error("fulfillment_child_exited_with_pending_request")); }
      this.waiting.clear(); accept();
    }));
    this.child.once("error", () => { clearTimeout(timer); fail(new Error("fulfillment_child_spawn_failed")); });
    this.child.on("message", raw => {
      if (!raw || typeof raw !== "object") return; const message = raw as Record<string, unknown>;
      if (message.nonce !== nonce) return;
      if (message.type === "ready") { clearTimeout(timer); ready(); return; }
      if (typeof message.id !== "number") return;
      const pending = this.waiting.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); this.waiting.delete(message.id);
      if (message.type === "result") pending.resolve(message.value);
      else pending.reject(new Error("fulfillment_child_failed_" + (typeof message.phase === "string" && /^[a-z0-9_]{1,80}$/.test(message.phase) ? message.phase : "unknown") +
        (typeof message.code === "string" && /^[A-Z0-9]{5}$/.test(message.code) ? "_" + message.code : "")));
    });
  }
  async request(input: Record<string, unknown>) {
    await this.ready; if (!this.child.connected || this.evidence.exited) throw new Error("fulfillment_child_unavailable");
    const id = ++this.sequence;
    return new Promise<unknown>((accept, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error("fulfillment_child_request_timeout")); }, input.operation === "seed" ? 180_000 : 20_000);
      this.waiting.set(id, { resolve: accept, reject, timer });
      this.child.send({ ...input, nonce: this.nonce, id }, error => { if (error) { clearTimeout(timer); this.waiting.delete(id); reject(new Error("fulfillment_child_request_delivery_failed")); } });
    });
  }
  close() { return this.closing ??= this.drain(); }
  private async drain() {
    const errors: unknown[] = [];
    try { if (!this.evidence.exited) { const result = z.object({ closed: z.literal(true), restored: z.literal(true) }).strict().parse(await this.request({ operation: "close" }));
      this.evidence.closeAcknowledged = result.closed; this.evidence.restored = result.restored; } } catch (error) { errors.push(error); }
    try { if (this.child.connected) this.child.disconnect(); this.evidence.disconnected = true; } catch (error) { errors.push(error); }
    try { await bounded(this.ended, "fulfillment_child_close_timeout", 20_000); }
    catch (error) { errors.push(error); this.child.kill("SIGKILL"); try { await bounded(this.ended, "fulfillment_child_kill_exit_timeout", 2_000); } catch (failure) { errors.push(failure); } }
    if (this.evidence.exitCode !== 0 || this.evidence.signal || !this.evidence.closeAcknowledged) errors.push(new Error("fulfillment_child_unclean_shutdown"));
    if (errors.length) throw new AggregateError(errors, "fulfillment_child_cleanup_failed");
  }
}

const panel = (page: Page) => page.getByRole("region", { name: "核对本单履约依据", exact: true });
const section = (page: Page, kind: AgentFulfillmentKind) => panel(page).getByRole("region", { name: ({ production: "生产", shipments: "发货", logistics: "物流" }[kind]) + "履约依据", exact: true });
async function session(page: Page) {
  const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200);
  return ErpSessionViewSchema.parse(await response.json());
}
async function choose(page: Page, source: Source) {
  await expect(panel(page)).toBeVisible();
  const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/agent-fulfillment/candidates" && value.request().method() === "POST");
  await panel(page).getByRole("button", { name: "读取真实订单候选", exact: true }).click();
  const actual = await response; expect(actual.status()).toBe(200); const candidates = AgentFulfillmentCandidatesSchema.parse(await actual.json());
  expect(candidates.items.some(item => item.id === source.orderId && item.expectedSequence === source.expectedSequence)).toBe(true);
  await panel(page).getByRole("combobox", { name: "选择履约原订单", exact: true }).selectOption(source.orderId);
}
async function read(page: Page, source: Source, kind: AgentFulfillmentKind, next = false) {
  const authority = erpSessionAuthority(await session(page));
  const response = page.waitForResponse(value => {
    if (new URL(value.url()).pathname !== "/api/agent-fulfillment/call" || value.request().method() !== "POST") return false;
    const call = AgentFulfillmentCallSchema.safeParse(value.request().postDataJSON()); return call.success && call.data.input.orderId === source.orderId && call.data.input.kind === kind;
  });
  const label = { production: "生产", shipments: "发货", logistics: "物流" }[kind];
  const button = next ? section(page, kind).getByRole("button", { name: `读取下一页${label}依据`, exact: true })
    : section(page, kind).getByRole("button", { name: new RegExp(`^(读取${label}依据|重新读取${label}第一页)$`) });
  await button.click(); const actual = await response; expect(actual.status()).toBe(200);
  const call = AgentFulfillmentCallSchema.parse(actual.request().postDataJSON()), result = AgentFulfillmentResultSchema.parse(await actual.json());
  expect(result.contextAuthority).toBe(authority); expect(actual.headers()["x-yummyai-context-authority"]).toBe(authority);
  expect(call.input.expectedSequence).toBe(source.expectedSequence); await verifyAgentFulfillmentResult(result, call);
  await expect(section(page, kind).getByRole("region", { name: `${label}原来源页`, exact: true })).toBeVisible();
  return result;
}
async function settledVisual(locator: Locator) {
  await locator.scrollIntoViewIfNeeded(); await expect(locator).toBeVisible();
  await expect.poll(() => locator.evaluate(element => {
    const ancestors: Element[] = []; for (let current: Element | null = element; current; current = current.parentElement) ancestors.push(current);
    return { opaque: ancestors.every(current => getComputedStyle(current).opacity === "1"),
      running: [...new Set([...element.getAnimations({ subtree: true }), ...ancestors.flatMap(current => current.getAnimations())])]
        .filter(animation => animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity).length };
  })).toEqual({ opaque: true, running: 0 });
}
async function screenshot(page: Page, info: TestInfo, locator: Locator, name: string) {
  await settledVisual(locator); const path = info.outputPath(name + ".png"); await locator.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}
async function mobileViewport(page: Page, info: TestInfo, name: string, anchor: Locator, facts: readonly Locator[]) {
  await anchor.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await settledVisual(anchor);
  const visibility = () => Promise.all(facts.map(fact => fact.evaluate(element => {
    const rect = element.getBoundingClientRect(), clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const scrollContainers: Array<{ tag: string; className: string; scrollTop: number; clientHeight: number; scrollHeight: number }> = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) { clip.left = Math.max(clip.left, bounds.left); clip.right = Math.min(clip.right, bounds.right); }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) { clip.top = Math.max(clip.top, bounds.top); clip.bottom = Math.min(clip.bottom, bounds.bottom); }
      if (/auto|scroll/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight)
        scrollContainers.push({ tag: parent.tagName, className: parent.className, scrollTop: parent.scrollTop, clientHeight: parent.clientHeight, scrollHeight: parent.scrollHeight });
    }
    const insideViewportAndScrollClip = rect.width > 0 && rect.height > 0 && rect.left >= clip.left && rect.right <= clip.right && rect.top >= clip.top && rect.bottom <= clip.bottom;
    const x = rect.left + rect.width / 2;
    const unobscured = insideViewportAndScrollClip && [rect.top + 2, rect.top + rect.height / 2, rect.bottom - 2]
      .every(y => { const hit = document.elementFromPoint(x, y); return hit !== null && (hit === element || element.contains(hit)); });
    return { insideViewportAndScrollClip, unobscured, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, clip, scrollContainers };
  })));
  await expect.poll(async () => (await visibility()).every(value => value.insideViewportAndScrollClip && value.unobscured)).toBe(true);
  const visibleFacts = await visibility();
  expect(visibleFacts.every(value => value.scrollContainers.some(container => container.className.split(" ").includes("oc-whole-detail")))).toBe(true);
  expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
  const path = info.outputPath(name + ".png"); await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: "image/png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  return { name, viewport: page.viewportSize(), visibleFacts };
}
function observe(page: Page) {
  const calls: Array<{ path: string; method: string; bodyChecksum: string | null }> = [], failed: Array<{ request: Request; path: string; error: string | null; at: number }> = [];
  const httpErrors: Array<{ path: string; status: number; code: string | null }> = [], consoleErrors: Array<{ path: string; urlChecksum: string; checksum: string; at: number }> = [], pageErrors: string[] = [];
  const pending: Promise<void>[] = [], inFlightGets = new Map<Request, { done: Promise<void>; finish(): void }>();
  const identityMetadataPaths = new Set(["/api/agent-native/workspace", "/api/agent-native-v2/workspace", "/api/ai-assists/task-workspace", "/api/agent-commands/workspace"]);
  const metadataCancelledByIdentity = new Set<Request>();
  const requestIdentity = new Map<Request, { id: number; startedAt: number; document: number }>();
  const identityNavigations: Array<{ path: string; urlChecksum: string; at: number; document: number }> = [];
  let held: Request | undefined, transitionAt: number | undefined, transitionEndedAt: number | undefined, previousAuthority: string | undefined, nextAuthority: string | undefined;
  let document = 0;
  const authorityRelation = (request: Request) => {
    const stamp = request.headers()["x-yummyai-context-authority"];
    return stamp !== undefined && stamp === previousAuthority ? "previous" : stamp !== undefined && stamp === nextAuthority ? "current" : "other";
  };
  function pinMetadataRead(request: Request) {
    if (transitionAt !== undefined && transitionEndedAt === undefined && request.method() === "GET" &&
      identityMetadataPaths.has(new URL(request.url()).pathname) && authorityRelation(request) !== "other")
      metadataCancelledByIdentity.add(request);
  }
  page.on("framenavigated", frame => { if (frame !== page.mainFrame()) return; document++;
    if (transitionAt !== undefined && transitionEndedAt === undefined)
      identityNavigations.push({ path: new URL(frame.url()).pathname, urlChecksum: sha(frame.url()), at: Date.now(), document });
  });
  page.on("request", request => { const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) {
      calls.push({ path, method: request.method(), bodyChecksum: request.postData() ? sha(request.postData()!) : null });
      requestIdentity.set(request, { id: calls.length, startedAt: Date.now(), document });
      if (request.method() === "GET") { let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; }); inFlightGets.set(request, { done, finish }); }
      pinMetadataRead(request);
    } });
  page.on("requestfinished", request => { inFlightGets.get(request)?.finish(); inFlightGets.delete(request); });
  page.on("response", response => { if (response.status() < 400 || !new URL(response.url()).pathname.startsWith("/api/")) return;
    pending.push((async () => { let code: string | null = null; try { const body: unknown = await response.json(); if (body && typeof body === "object" && "code" in body && typeof body.code === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(body.code)) code = body.code; } catch { /* An unreadable body remains an unexpected HTTP error. */ }
      httpErrors.push({ path: new URL(response.url()).pathname, status: response.status(), code }); })()); });
  page.on("requestfailed", request => { inFlightGets.get(request)?.finish(); inFlightGets.delete(request);
    if (new URL(request.url()).pathname.startsWith("/api/")) failed.push({ request, path: new URL(request.url()).pathname, error: request.failure()?.errorText ?? null, at: Date.now() }); });
  page.on("console", message => { if (message.type() === "error") { let path = ""; try { path = new URL(message.location().url).pathname; } catch { /* Browser diagnostics may have no URL. */ }
    consoleErrors.push({ path, urlChecksum: sha(message.location().url), checksum: sha(message.text()), at: Date.now() }); } });
  page.on("pageerror", error => pageErrors.push(sha(error.name + ":" + error.message)));
  const diagnostics = () => ({ calls, httpErrors, pageErrors, observedConsoleErrors: consoleErrors,
    failedRequests: failed.map(({ request, path, error, at }) => ({ ...requestIdentity.get(request), path, method: request.method(), error, at,
      urlChecksum: sha(request.url()), authorityChecksum: sha(request.headers()["x-yummyai-context-authority"] ?? ""), authorityRelation: authorityRelation(request),
      exactMetadataRequestPinned: metadataCancelledByIdentity.has(request), heldResponse: request === held })), transitionAt: transitionAt ?? null,
    transitionEndedAt: transitionEndedAt ?? null, previousAuthorityChecksum: previousAuthority ? sha(previousAuthority) : null,
    nextAuthorityChecksum: nextAuthority ? sha(nextAuthority) : null, identityNavigations,
    heldUrlChecksum: held ? sha(held.url()) : null });
  return { calls, diagnostics, markHeld(request: Request) { held = request; },
    transition(previous: string, current: string) { transitionAt = Date.now(); previousAuthority = previous; nextAuthority = current; for (const request of inFlightGets.keys()) pinMetadataRead(request); },
    finishTransition() { transitionEndedAt = Date.now(); },
    async settleReads() {
      await page.waitForLoadState("domcontentloaded");
      // Wait for the current document to paint its mounted readers, then drain actual GET objects rather than sleeping or using networkidle.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await bounded((async () => { while (inFlightGets.size) await Promise.all([...inFlightGets.values()].map(value => value.done)); })(), "Actual page startup GET requests did not settle");
      expect(inFlightGets.size).toBe(0);
    }, async check() {
    await Promise.all(pending); expect(pageErrors).toEqual([]); expect(httpErrors).toEqual([]);
    const inIdentityWindow = (at: number) => transitionAt !== undefined && transitionEndedAt !== undefined && at >= transitionAt && at <= transitionEndedAt;
    const hasIdentityNavigation = identityNavigations.some(value => value.path === "/ai-tasks" && inIdentityWindow(value.at));
    const expected = failed.filter(value => hasIdentityNavigation && inIdentityWindow(value.at) && (value.request === held && authorityRelation(value.request) === "previous" && value.path === "/api/agent-fulfillment/call" && ["net::ERR_ABORTED", "net::ERR_FAILED"].includes(value.error ?? "") ||
      metadataCancelledByIdentity.has(value.request) && authorityRelation(value.request) !== "other" && value.request.method() === "GET" && identityMetadataPaths.has(value.path) && value.error === "net::ERR_ABORTED"));
    expect(failed.length).toBe(expected.length);
    expect(consoleErrors).toEqual([]);
    return { ...diagnostics(), expectedIdentityFailures: expected.map(value => ({ ...requestIdentity.get(value.request), path: value.path, method: value.request.method(), urlChecksum: sha(value.request.url()),
      authorityChecksum: sha(value.request.headers()["x-yummyai-context-authority"] ?? ""), authorityRelation: authorityRelation(value.request), error: value.error, heldResponse: value.request === held, at: value.at })), expectedConsoleErrors: 0 };
  } };
}

async function leaf(page: Page, info: TestInfo, action: (child: FulfillmentChild, source: Source, seen: ReturnType<typeof observe>, proof: Record<string, unknown>) => Promise<void>, returnTo = "/products") {
  const environment = requireFulfillmentEnvironment(process.env, true), seen = observe(page), proof: Record<string, unknown> = { operation: "6e2a9c74", test: info.title, nonce: environment.nonce,
    syntheticBoundary: "Initial order/work admissions and operator attestations are synthetic; original JPG Worker and business owners persist facts; only carrier transport is synthetic; no model is called", cleanupFailureCount: 0 };
  const child = new FulfillmentChild(environment.nonce); let failure: unknown; const errors: unknown[] = [];
  try {
    await loginErp(page, "operator", returnTo); await seen.settleReads(); const actual = await session(page), identity = actors().operator;
    expect([actual.tenantId, actual.userId]).toEqual([identity.tenantId, identity.userId]);
    const source = Seed.parse(await child.request({ operation: "seed", context: TenantContextSchema.parse(actual) }));
    proof.source = { orderId: source.orderId, expectedSequence: source.expectedSequence, productionIds: source.productionIds, importId: source.importId,
      inspectionId: source.inspectionId, shipmentId: source.shipmentId, logisticsTaskId: source.logisticsTaskId };
    await action(child, source, seen, proof);
  } catch (error) { failure = error; }
  finally {
    try { proof.network = await seen.check(); } catch (error) { proof.network = seen.diagnostics(); errors.push(error); }
    try { await child.close(); } catch (error) { errors.push(error); }
    proof.childClose = child.evidence; proof.cleanupFailureCount = errors.length;
    const path = info.outputPath("agent-fulfillment-proof.json"); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(proof, null, 2) + "\n");
    await info.attach("agent-fulfillment-proof", { path, contentType: "application/json" });
  }
  if (failure || errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], "Personal fulfillment acceptance or cleanup failed");
}

test("reads the real same-order formal production factory observation quality handover and logistics evidence at desktop and 390 without paid or business writes", async ({ page }, info) => {
  await leaf(page, info, async (child, source, seen, proof) => {
    const beforeOriginalPage = State.parse(await child.request({ operation: "state" }));
    await page.goto(`/production?${new URLSearchParams({ order: source.orderId, line: source.lineId })}`);
    await expect(panel(page)).toBeVisible(); await expect(panel(page)).toContainText(source.orderId);
    await seen.settleReads();
    expect(seen.calls.filter(call => call.path === "/api/agent-fulfillment/call").length).toBe(0);
    const before = State.parse(await child.request({ operation: "state" }));
    proof.originalPageProjectionMaintenance = { before: beforeOriginalPage.tables.order_work_items, after: before.tables.order_work_items,
      source: "Original OrderWorkspaceService refreshSearchProjection maintains searchRevision/specification/designExecutor during original page initialization; full read-only baseline starts after those actual GETs settle and before any fulfillment call." };
    await expect(panel(page).getByRole("button", { name: "读取真实订单候选", exact: true })).toHaveCount(0);
    const first = await read(page, source, "production"); if (first.data.kind !== "production") throw new Error("Actual production response expected");
    expect(first.input.expectedSequence).toBe(source.expectedSequence); expect(source.expectedSequence).toBeGreaterThan(1);
    expect(first.data.coverage).toMatchObject({ indexedTotal: 6, returned: 5, hasMore: true, complete: false });
    const production = section(page, "production").getByRole("article", { name: `原生产单 ${source.firstProductionId}`, exact: true });
    await expect(production.getByRole("region", { name: "工厂原表观察", exact: true })).toContainText("工厂已发货");
    const quality = production.getByRole("region", { name: "原实物质检组", exact: true });
    await quality.locator("summary").filter({ hasText: "原实物质检组历史" }).click();
    await expect(quality).toContainText("检验通过"); await expect(quality).toContainText("检验未通过");
    await screenshot(page, info, production.getByRole("region", { name: "工厂原表观察", exact: true }), "desktop-factory-observation");
    await screenshot(page, info, quality, "desktop-quality-groups");
    const second = await read(page, source, "production", true); expect(second.data.rows).toHaveLength(1);
    expect(new Set([...first.data.rows, ...second.data.rows].map(row => row.id)).size).toBe(6); expect(second.data.coverage.complete).toBe(false);
    await section(page, "production").getByRole("button", { name: "生产依据上一已读页", exact: true }).click();
    const qualityHistory = quality.locator("details").filter({ has: page.locator("summary").filter({ hasText: "原实物质检组历史" }) }).first();
    if (!(await qualityHistory.evaluate(element => element instanceof HTMLDetailsElement && element.open))) await qualityHistory.locator("summary").first().click();
    const shipment = await read(page, source, "shipments"); if (shipment.data.kind !== "shipments") throw new Error("Actual shipment response expected");
    expect(shipment.data.rows[0]!.physicalHandover).toMatchObject({ packageCount: 1, dispatchedPackageCount: 1, allDispatched: true });
    const logistics = await read(page, source, "logistics"); if (logistics.data.kind !== "logistics") throw new Error("Actual logistics response expected");
    expect(logistics.data.rows[0]).toMatchObject({ id: source.logisticsTaskId, quotedCostMinor: 500, actualCostMinor: 600, quotedCurrency: "USD", actualCurrency: "USD", minorUnitDigits: 2 });
    const logisticsArticle = section(page, "logistics").getByRole("article", { name: `原物流任务 ${source.logisticsTaskId}`, exact: true });
    await expect(logisticsArticle).toContainText("USD 5.00"); await expect(logisticsArticle).toContainText("USD 6.00");
    await screenshot(page, info, logisticsArticle, "desktop-logistics-original-cost");
    await page.setViewportSize({ width: 390, height: 844 });
    const pair = (parent: Locator, label: string) => parent.locator("dl > div").filter({ has: page.locator("dt").filter({ hasText: new RegExp(`^${label}$`) }) });
    const factory = production.getByRole("region", { name: "工厂原表观察", exact: true });
    const factoryState = pair(factory, "原工厂状态"), factoryQuantity = pair(factory, "实际工厂发货数量");
    await expect(factoryState).toContainText("工厂已发货"); await expect(factoryQuantity).toContainText("未知 未当作零");
    const passedGroup = qualityHistory.locator(":scope > ol > li").filter({ has: page.locator("dd").filter({ hasText: /^检验通过/ }) });
    const failedGroup = qualityHistory.locator(":scope > ol > li").filter({ has: page.locator("dd").filter({ hasText: /^检验未通过/ }) });
    const passedCount = pair(passedGroup, "原组数量"), passed = pair(passedGroup, "原组检验"), passedHandover = pair(passedGroup, "原组已交运");
    const failedCount = pair(failedGroup, "原组数量"), failed = pair(failedGroup, "原组检验"), failedHandover = pair(failedGroup, "原组已交运");
    await expect(passedCount.locator("dd")).toHaveText("3"); await expect(passedHandover.locator("dd")).toHaveText("3");
    await expect(failedCount.locator("dd")).toHaveText("2"); await expect(failedHandover.locator("dd")).toHaveText("0");
    const quote = pair(logisticsArticle, "原报价"), cost = pair(logisticsArticle, "原实际费用");
    const mobileViewports = [
      await mobileViewport(page, info, "mobile-factory-observation", factoryState, [factoryState, factoryQuantity]),
      await mobileViewport(page, info, "mobile-quality-passed", passed, [passedCount, passed, passedHandover]),
      await mobileViewport(page, info, "mobile-quality-failed", failed, [failedCount, failed, failedHandover]),
      await mobileViewport(page, info, "mobile-logistics-original-cost", quote, [quote, cost]),
    ];
    proof.mobileViewports = mobileViewports;
    await expect(panel(page).getByRole("button", { name: /确认执行|准备原操作|购单|批准|提交工厂/ })).toHaveCount(0);
    const paidPosts = () => seen.calls.filter(call => call.method === "POST" && /\/api\/(ai-assists\/runs|agent-native(?:-v2)?\/runs|agent-commands)/.test(call.path)).length;
    expect(paidPosts()).toBe(0); const callsBeforeReload = seen.calls.filter(call => call.path === "/api/agent-fulfillment/call").length;
    await page.reload(); await expect(panel(page)).toBeVisible(); await seen.settleReads(); await expect(panel(page).getByRole("region", { name: /原来源页$/ })).toHaveCount(0);
    expect(seen.calls.filter(call => call.path === "/api/agent-fulfillment/call").length).toBe(callsBeforeReload);
    const restored = await read(page, source, "production"); expect(restored.dataChecksum).toBe(first.dataChecksum);
    expect(State.parse(await child.request({ operation: "state" }))).toEqual(before); expect(paidPosts()).toBe(0);
    Object.assign(proof, { originalOrderEntry: true, orderSequenceUsed: source.expectedSequence, reads: [first, second, shipment, logistics].map(value => ({ kind: value.input.kind,
      callId: value.callId, inputChecksum: value.inputChecksum, dataChecksum: value.dataChecksum, returned: value.data.rows.length, complete: value.data.coverage.complete })),
      immutableBusinessLedgerAndQueues: true, modelCalls: 0, responsiveWidths: [1440, 390], reloadDidNotResubmit: true });
  });
});

test("discards an already completed original response after real PII scope narrowing and keeps current empty permissions distinct from absent facts", async ({ page }, info) => {
  await leaf(page, info, async (child, source, seen, proof) => {
    await choose(page, source); const original = await read(page, source, "production"); await seen.settleReads();
    const before = State.parse(await child.request({ operation: "state" }));
    const entered = latch(), release = latch(), settled = latch(); let returned = false, routeErrorHash: string | null = null, heldChecksum: string | null = null;
    await page.route("**/api/agent-fulfillment/call", async route => {
      const parsed = AgentFulfillmentCallSchema.safeParse(route.request().postDataJSON());
      if (!parsed.success || parsed.data.input.orderId !== source.orderId || parsed.data.input.kind !== "production") { await route.continue(); return; }
      seen.markHeld(route.request());
      try { const response = await route.fetch(); expect(response.status()).toBe(200); const body = await response.body(); heldChecksum = sha(body.toString("utf8"));
        entered.release(); await release.promise;
        try { await route.fulfill({ response, body }); returned = true; } catch (error) { routeErrorHash = sha(error instanceof Error ? error.name + ":" + error.message : "held_route_failed"); }
      } finally { settled.release(); }
    });
    try {
      await section(page, "production").getByRole("button", { name: "重新读取生产第一页", exact: true }).click(); await bounded(entered.promise, "Completed actual fulfillment BFF response did not reach gate");
      const narrowed = z.object({ contextAuthority: z.string() }).strict().parse(await child.request({ operation: "narrow", bit: Permission.OrderPiiRead }));
      const fresh = await session(page), authority = erpSessionAuthority(fresh); expect(authority).toBe(narrowed.contextAuthority);
      expect(fresh.permissionScopes?.[Permission.OrderPiiRead]).toBe("self"); expect(fresh.permissionScopes?.[Permission.OrderRead]).toBe("tenant");
      expect(authority).not.toBe(original.contextAuthority);
      seen.transition(original.contextAuthority, authority); const navigation = page.waitForEvent("framenavigated", frame => frame === page.mainFrame());
      await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await navigation; await expect(panel(page)).toBeVisible();
      await seen.settleReads();
      const response = await page.request.get("/api/agent-fulfillment/workspace", { headers: { "x-yummyai-context-authority": authority } });
      expect(response.status()).toBe(200); const workspace = AgentFulfillmentWorkspaceSchema.parse(await response.json());
      expect(workspace.contextAuthority).toBe(authority); expect(workspace.sourcePermissions).toEqual({ production: true, shipments: true, factory: false, logistics: false });
      release.release(); await bounded(settled.promise, "Original completed fulfillment response did not settle after identity navigation");
      await page.unroute("**/api/agent-fulfillment/call"); await expect(panel(page).getByRole("region", { name: /原来源页$/ })).toHaveCount(0);
      await expect(panel(page).getByRole("article", { name: `原生产单 ${source.firstProductionId}`, exact: true })).toHaveCount(0);
      await expect(section(page, "logistics")).toContainText("当前未获此原来源读取权限");
      await expect(section(page, "logistics").getByRole("button", { name: "读取物流依据", exact: true })).toBeDisabled();
      await choose(page, source); const current = await read(page, source, "production"); if (current.data.kind !== "production") throw new Error("Actual production response expected");
      expect(current.data.rows[0]!.factory).toEqual({ state: "unavailable", reason: "permission_required", data: null });
      const origin = new URL(page.url()).origin; expect(origin).toBe("http://localhost:3130");
      const deniedCall = AgentFulfillmentCallSchema.parse({ version: workspace.version, tool: workspace.definition.tool, executionContract: workspace.executionContract,
        definitionChecksum: workspace.definition.definitionChecksum, input: { orderId: source.orderId, expectedSequence: source.expectedSequence, kind: "logistics", pageSize: 5, cursor: null } });
      const denied = await page.request.post("/api/agent-fulfillment/call", { headers: { origin, "content-type": "application/json", "x-yummyai-context-authority": authority }, data: deniedCall });
      expect(denied.status()).toBe(403); expect(State.parse(await child.request({ operation: "state" }))).toEqual(before);
      await seen.settleReads(); seen.finishTransition();
      await expect(panel(page).getByRole("button", { name: /确认执行|准备原操作|购单|批准|提交工厂/ })).toHaveCount(0);
      Object.assign(proof, { actualOriginalBodyHeld: heldChecksum, returned, routeErrorHash, previousDataChecksum: original.dataChecksum,
        newDataChecksum: current.dataChecksum, currentAuthorityChecksum: sha(authority), actualCurrentPiiScope: "self", hiddenOldPrivateFacts: true, realCurrentBffDenied: 403,
        businessLedgerAndQueuesUnchanged: true, modelCalls: 0 });
    } finally { release.release(); await bounded(settled.promise, "Held fulfillment route cleanup did not complete"); await page.unroute("**/api/agent-fulfillment/call"); }
  }, "/ai-tasks");
});
