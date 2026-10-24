import { expect, test, type Page, type Request, type TestInfo } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { StoreNodeEnrollmentCreatedSchema, StoreNodeEnrollmentBundleSchema, StoreNodeWorkspaceSchema, type StoreNodeEnrollmentCreated } from "@yummyai/contracts/marketplace/store-node";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { requireStoreNodeIdentityEnvironment } from "../../../tools/testing/require-store-node-identity-environment.mjs";
import { loginErp, actors } from "./erp-identity-fixture";

const { nonce } = requireStoreNodeIdentityEnvironment(process.env, "current", true), sha = (value: string) => createHash("sha256").update(value).digest("hex");
const Id = z.uuidv7(), Seed = z.object({ groupId: Id, ids: z.array(Id).length(2), actorId: Id, tenantId: Id }).strict();
const PublicKey = z.object({ keyId: Id, publicKeyPem: z.string().startsWith("-----BEGIN PUBLIC KEY-----\n") }).strict();
const Snapshot = z.object({ business: z.object({ paid: z.int(), publications: z.int(), syncs: z.int() }).strict(), nodes: z.array(z.object({ id: Id, accountId: Id,
  status: z.string(), generation: z.int(), sequence: z.int(), sessionId: Id.nullable(), creationRequestKey: z.string().regex(/^[a-f0-9]{64}$/) }).strict()), originalRowsSha: z.string().regex(/^[a-f0-9]{64}$/),
  counts: z.record(z.string(), z.number()), children: z.array(z.object({ command: z.string(), exited: z.boolean(), code: z.number().nullable(), leaked: z.boolean(), stdoutBytes: z.int(), stderrBytes: z.int(), states: z.array(z.object({ state: z.string(), sequence: z.int().optional(), code: z.string().optional() }).strict()) }).strict()) }).strict();
type Source = z.infer<typeof Seed>;
async function control(input: Record<string, unknown>) {
  const path = fileURLToPath(new URL(`../../../tmp/store-node-identity-20261022-c7e3a6d2/qa/browser-control-${nonce}.json`, import.meta.url));
  const info = z.object({ nonce: z.literal(nonce), pid: z.int().positive(), origin: z.url(), key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(JSON.parse(await readFile(path, "utf8")));
  const url = new URL(info.origin); if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("store_node_browser_control_origin_invalid");
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-fixture-control": info.key }, body: JSON.stringify(input), redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (response.status !== 200) { await response.body?.cancel(); throw new Error("store_node_browser_control_rejected"); } return await response.json() as unknown;
}
const snapshot = async (source: Source) => Snapshot.parse(await control({ operation: "snapshot", groupId: source.groupId }));
const panel = (page: Page) => page.getByRole("region", { name: "本店独立节点", exact: true });
async function session(page: Page) { const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200); const value = ErpSessionViewSchema.parse(await response.json());
  expect(value.userId).toBe(actors().operator.userId); expect(value.tenantId).toBe(actors().operator.tenantId); return { value, authority: erpSessionAuthority(value) }; }

function observe(page: Page) {
  const records: Array<{ ordinal: number; request: Request; method: string; path: string; queryEmpty: boolean; at: number; terminalAt: number | null; generation: number; documentOrdinal: number | null; navigationRequest: boolean; mainFrame: boolean; resourceType: string;
    authorityHash: string | null; responseAuthority: string | null; status: number | null; failed: string | null; terminal: boolean; prefetch: boolean }> = [];
  const consoleErrors: Array<{ at: number; failedResource: boolean; path: string | null; used: boolean }> = [], pageErrors: string[] = [], lost = new Map<Request, { status: 201; nodeId: string; failureConsumed: boolean; consoleConsumed: boolean }>();
  let ordinal = 0, generation = 0, documentOrdinal: number | null = null, transition: { accountId: string; started: number; focusAt: number; finished: number; old: string; current: string; held: Request } | null = null;
  let lastClassification: object[] = [];
  const navigations: Array<{ at: number; generation: number; documentOrdinal: number | null; path: string; queryEmpty: boolean }> = [];
  const expectedDenials = new Set<Request>(), known = new Set<string>();
  page.on("framenavigated", frame => { if (frame !== page.mainFrame()) return; const url = new URL(frame.url());
    if (url.origin === "http://localhost:3130") navigations.push({ at: Date.now(), generation, documentOrdinal, path: url.pathname, queryEmpty: !url.search }); });
  page.on("request", request => { const url = new URL(request.url()); if (url.origin !== "http://localhost:3130") return;
    const authority = request.headers()["x-yummyai-context-authority"], mainFrame = request.frame() === page.mainFrame(), resourceType = request.resourceType(), navigationRequest = request.isNavigationRequest();
    const requestOrdinal = ++ordinal;
    if (mainFrame && resourceType === "document" && navigationRequest) { generation++; documentOrdinal = requestOrdinal; }
    records.push({ ordinal: requestOrdinal, request, method: request.method(), path: url.pathname, queryEmpty: !url.search, at: Date.now(), terminalAt: null, generation, documentOrdinal, navigationRequest,
      mainFrame, resourceType, authorityHash: authority && /^[a-f0-9]{64}$/.test(authority) ? authority : null,
      responseAuthority: null, status: null, failed: null, terminal: false, prefetch: request.headers()["next-router-prefetch"] === "1" }); });
  page.on("response", response => { const row = records.find(value => value.request === response.request()); if (row) { row.status = response.status(); const authority = response.headers()["x-yummyai-context-authority"];
    row.responseAuthority = authority && /^[a-f0-9]{64}$/.test(authority) ? authority : null; } });
  page.on("requestfinished", request => { const row = records.find(value => value.request === request); if (row) { row.terminal = true; row.terminalAt = Date.now(); } });
  page.on("requestfailed", request => { const row = records.find(value => value.request === request); if (row) { row.terminal = true; row.terminalAt = Date.now(); row.failed = request.failure()?.errorText ?? "unknown"; } });
  page.on("console", message => { if (message.type() !== "error") return; let path: string | null = null;
    try { const url = new URL(message.location().url); if (url.origin === "http://localhost:3130" && !url.search && !url.hash) path = url.pathname; } catch { /* Unknown console location remains unclassified. */ }
    consoleErrors.push({ at: Date.now(), failedResource: message.text() === "Failed to load resource: net::ERR_FAILED", path, used: false }); });
  page.on("pageerror", error => pageErrors.push(error.name));
  const idle = async (except?: Request) => { await expect.poll(() => records.filter(value => !value.terminal && value.request !== except && !(transition && value.request === transition.held)).length, { timeout: 20_000 }).toBe(0); };
  const safeRecord = (row: typeof records[number]) => ({ ordinal: row.ordinal, method: row.method, path: row.path, queryEmpty: row.queryEmpty, at: row.at, terminalAt: row.terminalAt,
    generation: row.generation, documentOrdinal: row.documentOrdinal, navigationRequest: row.navigationRequest, mainFrame: row.mainFrame, resourceType: row.resourceType,
    authorityHash: row.authorityHash, responseAuthority: row.responseAuthority, status: row.status, failed: row.failed, terminal: row.terminal, prefetch: row.prefetch });
  const safeNetwork = () => records.map(safeRecord);
  const safeTransition = () => transition ? { accountId: transition.accountId, started: transition.started, focusAt: transition.focusAt, finished: transition.finished,
    oldAuthorityHash: sha(transition.old), currentAuthorityHash: sha(transition.current), heldOrdinal: records.find(row => row.request === transition!.held)?.ordinal ?? null } : null;
  return { idle, known: (authority: string) => known.add(sha(authority)), lost: (request: Request, nodeId: string) => lost.set(request, { status: 201, nodeId, failureConsumed: false, consoleConsumed: false }),
    denial: (request: Request) => expectedDenials.add(request), transition: (value: NonNullable<typeof transition>) => {
      const id = Id.parse(value.accountId), held = records.find(row => row.request === value.held);
      if (!held || held.path !== `/api/marketplace-accounts/${id}/nodes` || !known.has(sha(value.old)) || !known.has(sha(value.current)) || value.old === value.current ||
        value.started > value.focusAt || value.focusAt > value.finished) throw new Error("store_node_identity_transition_evidence_invalid");
      transition = value;
    },
    async check() { await idle(); const classified: object[] = [], failures: object[] = []; lastClassification = classified;
      for (const row of records) {
        const loss = lost.get(row.request);
        if (loss && row.method === "POST" && /^\/api\/marketplace-accounts\/[a-f0-9-]{36}\/nodes\/enrollments$/.test(row.path) && row.queryEmpty && row.failed === "net::ERR_FAILED") {
          loss.failureConsumed = true; classified.push({ ordinal: row.ordinal, classification: "explicit_lost_original201", nodeId: loss.nodeId }); continue;
        }
        if (row.status !== null && row.status >= 400 && !(expectedDenials.has(row.request) && row.status === 403)) failures.push({ ordinal: row.ordinal, reason: "http", status: row.status, path: row.path });
        if (!row.failed) continue;
        const prefetch = row.prefetch && row.method === "GET" && row.status === 200 && ["/", "/navigation", "/stores", "/orders", "/listings"].includes(row.path);
        const held = transition && row.request === transition.held && row.method === "GET" && row.queryEmpty && /^\/api\/marketplace-accounts\/[a-f0-9-]{36}\/nodes$/.test(row.path) && row.failed === "net::ERR_ABORTED" &&
          row.at <= transition.started && row.authorityHash === sha(transition.old) && known.has(sha(transition.old)) && known.has(sha(transition.current)) &&
          (row.responseAuthority === null || row.responseAuthority === row.authorityHash);
        const change = transition;
        const paths = change ? [`/api/marketplace-accounts/${change.accountId}/authority`, `/api/marketplace-accounts/${change.accountId}/nodes`] : [];
        const reloads = change ? records.filter(value => value.method === "GET" && value.mainFrame && value.resourceType === "document" && value.navigationRequest &&
          value.at >= change.focusAt && value.at <= change.finished && value.path === `/stores/${change.accountId}` && value.queryEmpty) : [];
        const document = reloads.length === 1 ? reloads[0] : undefined;
        const documentComplete = change && document && document.status === 200 && document.terminal && document.failed === null && document.terminalAt !== null &&
          document.terminalAt >= document.at && document.terminalAt <= change.finished && document.generation > row.generation && document.documentOrdinal === document.ordinal;
        const recovered = change && document && documentComplete ? paths.map(path => records.filter(value => value.method === "GET" && value.path === path && value.queryEmpty && value.mainFrame && value.resourceType === "fetch" &&
          value.generation === document.generation && value.documentOrdinal === document.ordinal && value.at >= document.at && value.terminalAt !== null && value.terminalAt <= change.finished &&
          value.status === 200 && value.terminal && value.failed === null && value.authorityHash === sha(change.current) && value.responseAuthority === value.authorityHash)) : [];
        const withdrawnMetadata = change && row.request !== change.held && row.method === "GET" && paths.includes(row.path) && row.queryEmpty && row.mainFrame && row.resourceType === "fetch" && !row.prefetch &&
          row.status === null && row.responseAuthority === null && row.failed === "net::ERR_ABORTED" && row.authorityHash === sha(change.old) && known.has(sha(change.old)) && known.has(sha(change.current)) &&
          row.at >= change.focusAt && row.terminalAt !== null && row.terminalAt >= row.at && row.terminalAt <= change.finished && recovered.length === 2 && recovered.every(value => value.length > 0);
        if (withdrawnMetadata && change) classified.push({ ordinal: row.ordinal, classification: "old_authority_metadata_cancel_in_explicit_withdrawal", path: row.path,
          requestAt: row.at, terminalAt: row.terminalAt, generation: row.generation, window: { started: change.started, focusAt: change.focusAt, finished: change.finished },
          oldAuthorityHash: sha(change.old), currentAuthorityHash: sha(change.current), reload: document ? safeRecord(document) : null, currentReads: recovered.map(values => values.map(value => ({ ordinal: value.ordinal, path: value.path,
            generation: value.generation, documentOrdinal: value.documentOrdinal, status: value.status, authorityHash: value.authorityHash, responseAuthority: value.responseAuthority, terminalAt: value.terminalAt }))) });
        else if (prefetch || held) classified.push({ ordinal: row.ordinal, classification: prefetch ? "exact_next_prefetch_cancel" : "held_old_authority_read_cancel", path: row.path });
        else failures.push({ ordinal: row.ordinal, reason: "unknown_failure", path: row.path, method: row.method, status: row.status, failure: row.failed });
      }
      for (const [request, loss] of lost) if (loss.failureConsumed) {
        const record = records.find(value => value.request === request)!;
        const matching = consoleErrors.filter(value => !value.used && value.failedResource && value.path === record.path && value.at >= record.at);
        if (matching.length === 1) { matching[0]!.used = true; loss.consoleConsumed = true; }
      }
      expect(failures).toEqual([]); expect(consoleErrors.filter(value => !value.used)).toEqual([]); expect(pageErrors).toEqual([]);
      for (const loss of lost.values()) { expect(loss.failureConsumed).toBe(true); expect(loss.consoleConsumed).toBe(true); }
      return { network: safeNetwork(), navigations, transition: safeTransition(), classified, consoleErrors: consoleErrors.length, pageErrors: pageErrors.length, knownInjectedLosses: lost.size };
    }, proof: () => ({ network: safeNetwork(), navigations, transition: safeTransition(), classified: lastClassification, consoleErrors: consoleErrors.length, pageErrors: pageErrors.length }),
  };
}
async function open(page: Page, source: Source, accountId: string, seen: ReturnType<typeof observe>, first = false) {
  if (first) await loginErp(page, "operator", "/stores/" + accountId); else { await seen.idle(); await page.goto("/stores/" + accountId); }
  await expect(panel(page)).toBeVisible(); await expect(panel(page).getByRole("button", { name: "准备节点登记", exact: true })).toBeEnabled();
  const actor = await session(page); expect(actor.value.userId).toBe(source.actorId); seen.known(actor.authority); await seen.idle(); return actor;
}
async function refresh(page: Page, seen: ReturnType<typeof observe>) { await seen.idle(); await panel(page).getByRole("button", { name: "重新读取节点状态", exact: true }).click(); await expect(panel(page)).toHaveAttribute("aria-busy", "false"); await seen.idle(); }
async function prepare(page: Page, key: z.infer<typeof PublicKey>, label: string) { await panel(page).getByRole("button", { name: "准备节点登记", exact: true }).click(); const form = panel(page).getByRole("form", { name: "创建节点登记票据" });
  await form.getByRole("textbox", { name: "节点名称", exact: true }).fill(label); await form.getByRole("textbox", { name: "节点公钥 PEM", exact: true }).fill(key.publicKeyPem);
  await form.getByRole("checkbox", { name: "已在节点主机保管私钥 本页只提交公开公钥", exact: true }).check(); }
async function register(page: Page, accountId: string, key: z.infer<typeof PublicKey>, label: string, source: Source, seen: ReturnType<typeof observe>) {
  await prepare(page, key, label);
  const response = page.waitForResponse(value => value.url() === `http://localhost:3130/api/marketplace-accounts/${accountId}/nodes/enrollments` && value.request().method() === "POST")
    .then(async value => ({ status: value.status(), body: await value.json() as unknown }));
  await panel(page).getByRole("button", { name: "创建一次性登记票据", exact: true }).click(); const actual = await response; expect(actual.status).toBe(201);
  const created = StoreNodeEnrollmentCreatedSchema.parse(actual.body); expect(created.workspace.context.actorId).toBe(source.actorId); expect(created.enrollment.accountId).toBe(accountId);
  const displayed = StoreNodeEnrollmentBundleSchema.parse(JSON.parse(await panel(page).getByRole("textbox", { name: "一次性节点登记包" }).inputValue())); expect(displayed).toEqual(created.enrollment);
  await seen.idle(); return created;
}
async function enrollAndRun(source: Source, key: z.infer<typeof PublicKey>, created: StoreNodeEnrollmentCreated) {
  const enrolled = z.object({ nodeId: Id, enrolled: z.literal(true) }).strict().parse(await control({ operation: "enroll", groupId: source.groupId, keyId: key.keyId, bundle: created.enrollment }));
  expect(enrolled.nodeId).toBe(created.enrollment.nodeId); await control({ operation: "run", groupId: source.groupId, keyId: key.keyId });
  await expect.poll(async () => (await snapshot(source)).nodes.find(value => value.id === enrolled.nodeId)?.sequence ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
}
async function bind(page: Page, nodeId: string) { await panel(page).getByRole("combobox", { name: /^待绑定节点/ }).selectOption(nodeId); await panel(page).getByRole("button", { name: "核对节点绑定", exact: true }).click();
  const review = panel(page).getByRole("region", { name: "核对节点变更", exact: true }); await review.getByRole("checkbox", { name: "已核对本店 原节点与本次变更", exact: true }).check(); await review.getByRole("button", { name: "确认绑定节点", exact: true }).click(); await expect(review).toHaveCount(0); }
async function screenshot(page: Page, info: TestInfo, name: string, label: string) { const card = panel(page).getByRole("article", { name: "节点 " + label, exact: true }); await card.scrollIntoViewIfNeeded(); await expect(card.getByRole("heading", { name: label, exact: true })).toBeVisible(); await expect.poll(() => panel(page).evaluate(element => ({ opacity: getComputedStyle(element).opacity,
  running: element.getAnimations({ subtree: true }).some(value => value.playState === "running" && value.effect?.getComputedTiming().iterations !== Infinity) }))).toEqual({ opacity: "1", running: false });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await expect(page.locator("[data-private-secret]")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(name + ".png"), fullPage: false }); }

test.describe.configure({ mode: "serial" });
test("registers an actual encrypted CLI identity, verifies mTLS online binding and read-only recovery at1440and390", async ({ page }, info) => {
  const source = Seed.parse(await control({ operation: "seed" })), seen = observe(page); const proof: Record<string, unknown> = {};
  try {
    await page.setViewportSize({ width: 1440, height: 1000 }); await open(page, source, source.ids[0]!, seen, true); const before = await snapshot(source);
    const key = PublicKey.parse(await control({ operation: "init", groupId: source.groupId })), label = "Synthetic standard CLI " + key.keyId;
    const created = await register(page, source.ids[0]!, key, label, source, seen); await enrollAndRun(source, key, created); await refresh(page, seen);
    const article = panel(page).getByRole("article", { name: "节点 " + label, exact: true }); await expect(article.getByText("在线", { exact: true })).toBeVisible(); await expect(article.getByText("已登记", { exact: true })).toBeVisible();
    await expect(panel(page).getByRole("region", { name: "本次节点登记包" })).toHaveCount(0); await bind(page, created.enrollment.nodeId); await seen.idle();
    await expect(panel(page).getByText("当前授权下有效", { exact: true })).toBeVisible(); await expect(panel(page).getByText("尚未集成", { exact: true })).toBeVisible(); await screenshot(page, info, "node-desktop-online", label);
    await control({ operation: "stop", groupId: source.groupId, keyId: key.keyId }); const fixed = await snapshot(source); await refresh(page, seen); await refresh(page, seen);
    expect((await snapshot(source)).originalRowsSha).toBe(fixed.originalRowsSha);
    await page.setViewportSize({ width: 390, height: 844 }); await screenshot(page, info, "node-mobile-read-only", label);
    const after = await snapshot(source); expect(after.business).toEqual(before.business); expect(after.counts).toEqual(before.counts); expect(after.children.every(value => !value.leaked)).toBe(true);
    Object.assign(proof, { accountId: source.ids[0], nodeId: created.enrollment.nodeId, originalRequest: created.workspace.nodes.find(value => value.id === created.enrollment.nodeId)?.creationRequestKey,
      actualCli: true, realMtls: true, modelCalls: 0, platformExecution: "not_integrated", metadataReadUnchanged: true, network: await seen.check() });
  } finally { try { proof.cleanup = await control({ operation: "close", groupId: source.groupId }); } finally { proof.observed = seen.proof(); await info.attach("store-node-proof", { body: JSON.stringify(proof), contentType: "application/json" }); } }
});

test("recovers one lost enrollment and drains a standby before takeover then hides an old bundle after real current authority withdrawal", async ({ page }, info) => {
  const source = Seed.parse(await control({ operation: "seed" })), seen = observe(page); const proof: Record<string, unknown> = {}; let releaseHeld!: () => void, heldRequest: Request | undefined;
  try {
    await page.setViewportSize({ width: 1440, height: 1000 }); const initial = await open(page, source, source.ids[0]!, seen, true), before = await snapshot(source);
    const firstKey = PublicKey.parse(await control({ operation: "init", groupId: source.groupId })), label = "Synthetic recovered node " + firstKey.keyId;
    await prepare(page, firstKey, label); let created: StoreNodeEnrollmentCreated | undefined, posts = 0;
    const path = `/api/marketplace-accounts/${source.ids[0]}/nodes/enrollments`;
    await page.route("**" + path, async route => { posts++; const original = await route.fetch(); expect(original.status()).toBe(201); created = StoreNodeEnrollmentCreatedSchema.parse(await original.json());
      expect(created.enrollment.accountId).toBe(source.ids[0]); seen.lost(route.request(), created.enrollment.nodeId); await route.abort("failed"); }, { times: 1 });
    await panel(page).getByRole("button", { name: "创建一次性登记票据", exact: true }).click(); await expect(panel(page).getByRole("region", { name: "原节点登记请求" })).toBeVisible();
    await panel(page).getByRole("button", { name: "只读取原节点状态", exact: true }).click(); await expect(panel(page).getByText("已读取到原节点 登记包只显示一次 丢失后需明确重新签发", { exact: true })).toBeVisible();
    expect(posts).toBe(1); expect(created).toBeDefined(); await expect(panel(page).getByRole("region", { name: "本次节点登记包" })).toHaveCount(0);
    await enrollAndRun(source, firstKey, created!); await refresh(page, seen); await bind(page, created!.enrollment.nodeId); await seen.idle();
    await panel(page).getByRole("button", { name: "结束本次登记核对", exact: true }).click();
    const standbyKey = PublicKey.parse(await control({ operation: "init", groupId: source.groupId })), standby = await register(page, source.ids[0]!, standbyKey, "Synthetic standby " + standbyKey.keyId, source, seen);
    await enrollAndRun(source, standbyKey, standby); await refresh(page, seen); await bind(page, standby.enrollment.nodeId);
    await expect(panel(page).getByText("旧租约排空中", { exact: true })).toBeVisible(); await control({ operation: "stop", groupId: source.groupId, keyId: firstKey.keyId });
    await control({ operation: "expire", groupId: source.groupId, nodeId: created!.enrollment.nodeId }); await refresh(page, seen); await bind(page, standby.enrollment.nodeId); await seen.idle();
    await expect(panel(page).getByText("当前授权下有效", { exact: true })).toBeVisible();
    const standbyArticle = panel(page).getByRole("article", { name: "节点 Synthetic standby " + standbyKey.keyId, exact: true }); await standbyArticle.getByRole("button", { name: "核对撤销节点", exact: true }).click();
    const review = panel(page).getByRole("region", { name: "核对节点变更", exact: true }); await review.getByRole("checkbox", { name: "已核对本店 原节点与本次变更", exact: true }).check(); await review.getByRole("button", { name: "确认撤销节点", exact: true }).click();
    await expect(standbyArticle.getByRole("definition").filter({ hasText: /^已撤销$/ })).toBeVisible(); await control({ operation: "stop", groupId: source.groupId, keyId: standbyKey.keyId }); await seen.idle();
    await screenshot(page, info, "node-desktop-takeover-and-revoke", "Synthetic standby " + standbyKey.keyId);
    await page.setViewportSize({ width: 390, height: 844 }); await screenshot(page, info, "node-mobile-revoked", "Synthetic standby " + standbyKey.keyId);
    await open(page, source, source.ids[1]!, seen); const key = PublicKey.parse(await control({ operation: "init", groupId: source.groupId }));
    const secret = await register(page, source.ids[1]!, key, "Synthetic private bundle " + key.keyId, source, seen); await expect(panel(page).locator("[data-private-secret]")).toHaveCount(1);
    let entered!: () => void; const ready = new Promise<void>(done => { entered = done; }), release = new Promise<void>(done => { releaseHeld = done; });
    await page.route(`**/api/marketplace-accounts/${source.ids[1]}/nodes`, async route => { if (route.request().method() !== "GET") { await route.continue(); return; }
      heldRequest = route.request(); const actual = await route.fetch(); expect(actual.status()).toBe(200); StoreNodeWorkspaceSchema.parse(await actual.json()); entered(); await release; await route.fulfill({ response: actual }); }, { times: 1 });
    await panel(page).getByRole("button", { name: "重新读取节点状态", exact: true }).click(); await ready;
    const transitionAt = Date.now(); await control({ operation: "rights", groupId: source.groupId, enabled: false }); const focusAt = Date.now(); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(async () => (await session(page)).authority, { timeout: 15_000 }).not.toBe(initial.authority); const changed = await session(page); seen.known(changed.authority);
    releaseHeld();
    await expect(page.locator("[data-private-secret]")).toHaveCount(0); await expect(panel(page).getByRole("button", { name: "准备节点登记", exact: true })).toHaveCount(0);
    expect((await page.locator("body").textContent())?.includes(secret.enrollment.ticketToken)).toBe(false);
    const denied = await page.request.post(`/api/marketplace-accounts/${source.ids[1]}/nodes/enrollments`, { headers: { origin: "http://localhost:3130", "x-yummyai-context-authority": sha(changed.authority) }, data: { label: "Synthetic denied", publicKeyPem: key.publicKeyPem,
      idempotencyKey: sha("denied:" + key.keyId), expectedAuthorizationGeneration: secret.workspace.authorizationGeneration, expectedBindingRevision: secret.workspace.binding.revision } }); expect(denied.status()).toBe(403);
    await seen.idle(heldRequest); seen.transition({ accountId: source.ids[1]!, started: transitionAt, focusAt, finished: Date.now(), old: initial.authority, current: changed.authority, held: heldRequest! });
    const after = await snapshot(source); expect(after.business).toEqual(before.business); expect(after.counts).toEqual(before.counts); expect(posts).toBe(1);
    Object.assign(proof, { primaryNodeId: created!.enrollment.nodeId, standbyNodeId: standby.enrollment.nodeId, secondAccountId: source.ids[1], lostPostCount: posts, originalRequestRecovered: true,
      drainExpiry: "only exact owned binding leaseExpiresAt moved under tenant RLS", privateBundleHidden: true, lateOriginalBodyDiscarded: true, currentAuthorityChanged: true, execution: "not_integrated", network: await seen.check() });
  } finally { releaseHeld?.(); await control({ operation: "rights", groupId: source.groupId, enabled: true }); try { proof.cleanup = await control({ operation: "close", groupId: source.groupId }); }
    finally { proof.observed = seen.proof(); await info.attach("store-node-proof", { body: JSON.stringify(proof), contentType: "application/json" }); } }
});
