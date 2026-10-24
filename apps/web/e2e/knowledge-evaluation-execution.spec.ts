import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { connectDatabase, type DatabaseConnection } from "@yummyai/database";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { KnowledgeFieldsSchema, type KnowledgeWorkspace } from "@yummyai/contracts/knowledge";
import { KnowledgeEvaluationReportSchema, KnowledgeSavedRecordSchema, StartKnowledgeEvaluationSchema, SaveKnowledgeEvaluationSchema,
  ReviewKnowledgeEvaluationSchema, type KnowledgeEvaluationReport } from "@yummyai/contracts/knowledge/governance";
import { KnowledgeEvaluationComparisonSchema, KnowledgeEvaluationRunPageSchema } from "@yummyai/contracts/knowledge/evaluation-read";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";
import { knowledgeGovernanceFixture } from "./knowledge-governance-fixture";
import { centerApi } from "./order-centers-fixture";
import { actors, loginErp } from "./erp-identity-fixture";

function isolation() {
  const url = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const api = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid");
  if (!nonce || !process.env.ERP_FIXTURE_ACTORS || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) || api.port !== "8130" ||
    process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_KNOWLEDGE_EVALUATION_ISOLATED !== "1" ||
    process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || process.env.E2E_COMPILED_WEB !== "1" ||
    process.env.WEB_AUTH_MODE !== "personal" || process.env.S3_PRIVATE_BUCKET !== "order-daily-e2e-" + nonce)
    throw new Error("Knowledge evaluation acceptance requires the exact isolated personal compiled nonce API and bucket before connection");
  return { url, nonce };
}
const isolated = isolation();

const endpoint = "/api/knowledge-governance/";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const ownedRoot = resolve(root, "tmp/knowledge-evaluation-20261021-e4c8a571/frontend/browser-proof", isolated.nonce);
const recoveryPrefix = "yummyai.knowledge-evaluation.start.v1:";
const evaluation = (page: Page) => page.getByRole("region", { name: "回答质量评测", exact: true });
const drawer = (page: Page) => page.getByRole("dialog", { name: "回答评测结果与版本对比", exact: true });
const runRegion = (page: Page) => page.getByRole("region", { name: "原评测运行", exact: true });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

type Owner = Awaited<ReturnType<typeof owner>>;
const unfinished = new Set<{ close(): Promise<void> }>();
async function owner(leaf: string) {
  isolation();
  const fixture = await knowledgeGovernanceFixture(`evaluation-execution-${leaf}`);
  const database: DatabaseConnection = connectDatabase(isolated.url.href);
  let closed = false;
  const proof: Record<string, unknown> = { nonce: isolated.nonce, leaf,
    admission: "Real personal OIDC, API, forced RLS, immutable evaluation protocol, Durable Assist processor and assessment; only provider HTTP transport is synthetic",
    cleanupOwner: "This test restores all synthetic role scopes and permissions and closes its connections; outer disposable runner removes nonce database, bucket and identity resources" };
  async function check() {
    if (closed || isolation().nonce !== isolated.nonce) throw new Error("Knowledge evaluation fixture scope changed");
    const [actual] = await database.client.unsafe<{ name: string }[]>("select current_database() as name");
    if (actual?.name !== "order_daily_e2e_" + isolated.nonce) throw new Error("Exact knowledge evaluation nonce database required");
  }
  const result = { fixture, database, proof, check,
    async close() {
      if (closed) return;
      const errors: string[] = [];
      try { await check(); await fixture.close(); proof.rolesRestored = true; }
      catch { errors.push("synthetic_role_restore_failed"); }
      try { await database.client.end(); proof.databaseConnectionClosed = true; }
      catch { errors.push("owned_connection_close_failed"); }
      closed = true; unfinished.delete(result); proof.cleanupErrors = errors;
      await mkdir(ownedRoot, { recursive: true });
      await writeFile(resolve(ownedRoot, leaf + ".json"), JSON.stringify(proof, null, 2) + "\n");
      if (errors.length) throw new Error("Knowledge evaluation acceptance cleanup incomplete: " + errors.join(","));
    },
  };
  try { await check(); } catch (error) { await result.close(); throw error; }
  unfinished.add(result); return result;
}
test.afterAll(async () => { for (const value of [...unfinished]) await value.close(); });

function observe(page: Page) {
  const starts: Array<{ caseId: string; input: ReturnType<typeof StartKnowledgeEvaluationSchema.parse> }> = [];
  const pageErrors: string[] = [], consoleErrors: Array<{ text: string; path: string }> = [];
  page.on("request", request => {
    const url = new URL(request.url()), match = /^\/api\/knowledge-governance\/evaluations\/([^/]+)\/start$/.exec(url.pathname);
    if (request.method() === "POST" && match) starts.push({ caseId: match[1]!, input: StartKnowledgeEvaluationSchema.parse(request.postDataJSON()) });
  });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") {
    let path = ""; try { path = new URL(message.location().url).pathname; } catch { /* No location is not an allowed failure. */ }
    consoleErrors.push({ text: message.text(), path });
  } });
  return { starts, pageErrors, consoleErrors };
}
async function ready(page: Page) {
  await expect(page.getByRole("heading", { name: "运营知识库", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "治理中心", exact: true }).click();
  await page.getByRole("button", { name: "质量评测", exact: true }).click();
  await expect(evaluation(page)).toBeVisible();
}
async function seedCard(value: Owner, leaf: string) {
  const title = `SYNTHETIC-EVALUATION-${leaf}-${randomUUID()}`;
  const answer = `Synthetic fixed answer ${randomUUID()}`;
  const fields = KnowledgeFieldsSchema.parse({ title, summary: "Synthetic approved fixed knowledge", body: answer,
    topic: "operations", platform: "amazon", market: "US", spuId: null, sourceType: "team", sourceLabel: "Synthetic evaluated source",
    sourceUrl: "", owner: "Synthetic operator", verifiedOn: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date()),
    reviewDueOn: "2099-12-31", tags: [] });
  const card = await centerApi<{ id: string }>("knowledge/create", { fields, expectedRevision: 0, reason: "Synthetic explicitly owned evaluation source", requestId: randomUUID() });
  for (const operation of ["submit", "publish"] as const) {
    const entry = (await centerApi<KnowledgeWorkspace>("knowledge/workspace")).entries.find(item => item.id === card.id);
    if (!entry) throw new Error("Actual newly created knowledge card missing");
    await centerApi(`knowledge/${card.id}/${operation}`, { expectedRevision: entry.revision, version: entry.latestVersion,
      reason: "Synthetic source checked and explicitly approved", requestId: randomUUID() });
  }
  value.proof.cardId = card.id;
  return { cardId: card.id, title, answer };
}
async function createCase(page: Page, source: Awaited<ReturnType<typeof seedCard>>) {
  const label = `SYNTHETIC-FIXED-CASE-${randomUUID()}`;
  await evaluation(page).getByRole("button", { name: "新建评测问题", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "新建评测问题", exact: true });
  await editor.getByLabel("问题名称", { exact: true }).fill(label);
  await editor.getByLabel("固定业务问题", { exact: true }).fill(source.title);
  await editor.getByLabel("主题", { exact: true }).selectOption("operations");
  await editor.getByLabel("平台", { exact: true }).selectOption("amazon");
  await editor.getByLabel("站点", { exact: true }).fill("US");
  await expect(editor.getByLabel("主题", { exact: true })).toHaveValue("operations");
  await expect(editor.getByLabel("平台", { exact: true })).toHaveValue("amazon");
  await expect(editor.getByLabel("站点", { exact: true })).toHaveValue("US");
  await editor.getByLabel("期望答案要点（每行一项）", { exact: true }).fill(source.answer);
  await editor.getByLabel("禁止出现的表述（每行一项）", { exact: true }).fill("Synthetic forbidden guarantee");
  await editor.getByRole("checkbox", { name: source.title + " · 已启用 V1", exact: true }).check();
  const changed = page.waitForResponse(response => new URL(response.url()).pathname === endpoint + "workspace" && response.request().method() === "GET");
  const submitted = page.waitForResponse(response => new URL(response.url()).pathname === endpoint + "evaluations/create" && response.request().method() === "POST");
  await editor.getByRole("button", { name: "保存固定问题", exact: true }).click();
  const response = await submitted; expect(response.status()).toBe(201);
  const original = SaveKnowledgeEvaluationSchema.parse(response.request().postDataJSON());
  expect(original.fields.search).toEqual({ query: source.title, topic: "operations", platform: "amazon", market: "US", spuIds: [] });
  expect(original.fields.requiredEntryIds).toEqual([source.cardId]);
  expect(response.headers()["x-yummyai-context-authority"]).toBeTruthy();
  const saved = KnowledgeSavedRecordSchema.parse(await response.json()); expect((await changed).status()).toBe(200);
  await expect(editor).toHaveCount(0); await ready(page);
  const row = evaluation(page).locator(".kb-row").filter({ hasText: label }); await expect(row).toHaveCount(1);
  return { id: saved.id, label };
}
async function start(page: Page, value: Owner, fixed: { id: string; label: string }) {
  await evaluation(page).getByRole("combobox", { name: "回答评测模型", exact: true }).selectOption(value.fixture.modelId);
  const row = evaluation(page).locator(".kb-row").filter({ hasText: fixed.label });
  await row.getByRole("button", { name: "运行回答评测", exact: true }).click();
  const prepared = page.getByRole("region", { name: "核对新的付费评测", exact: true });
  await expect(prepared).toContainText("新的独立尝试"); await expect(prepared).toContainText(fixed.id);
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === endpoint + `evaluations/${fixed.id}/start` && response.request().method() === "POST");
  await prepared.getByRole("button", { name: "确认提交这次付费评测", exact: true }).click();
  const response = await pending; expect(response.status()).toBe(201);
  const input = StartKnowledgeEvaluationSchema.parse(response.request().postDataJSON());
  const saved = KnowledgeSavedRecordSchema.parse(await response.json());
  return { input, id: saved.id };
}
async function readReport(page: Page, id: string) {
  const response = await page.request.get(endpoint + "evaluation-runs/" + id); expect(response.status()).toBe(200);
  return KnowledgeEvaluationReportSchema.parse(await response.json());
}
async function complete(value: Owner, report: KnowledgeEvaluationReport, original: Awaited<ReturnType<typeof seedCard>>) {
  expect(report.caseSnapshot.search).toEqual({ query: original.title, topic: "operations", platform: "amazon", market: "US", spuIds: [] });
  expect(report.caseSnapshot.requiredEntryIds).toEqual([original.cardId]);
  const source = report.answer.knowledge[0]; if (!source) throw new Error("Actual original evaluation retrieval source required");
  await value.fixture.analyze(report.answer.id, { summary: original.answer, findings: [{ title: "Synthetic original source", detail: original.answer,
    kind: "fact", severity: "info", evidence: [{ sourceId: source.sourceId, detail: "Synthetic answer checked against this pinned source" }], location: null }],
    directions: [], matches: [], missingInformation: [] });
}
async function exactState(value: Owner, caseId: string) {
  await value.check(); const actor = actors().operator;
  const [state] = await value.database.client.unsafe<Array<{ runs: number; protocols: number; assessments: number; starts: number; committedBudgets: number }>>(
    `select (select count(*)::int from knowledge_evaluation_runs where tenant_id=$1::uuid and case_id=$2::uuid and created_by=$3::uuid) as runs,
      (select count(*)::int from knowledge_evaluation_protocols p join knowledge_evaluation_runs r on r.id=p.run_id where r.tenant_id=$1::uuid and r.case_id=$2::uuid and r.created_by=$3::uuid) as protocols,
      (select count(*)::int from knowledge_evaluation_assessments a join knowledge_evaluation_runs r on r.id=a.run_id where r.tenant_id=$1::uuid and r.case_id=$2::uuid and r.created_by=$3::uuid) as assessments,
      (select count(*)::int from knowledge_governance_events where tenant_id=$1::uuid and resource_id=$2::uuid and action='evaluation.start') as starts,
      (select count(*)::int from ai_budget_ledger b join knowledge_evaluation_runs r on r.assist_run_id=b.request_id where r.tenant_id=$1::uuid and r.case_id=$2::uuid and r.created_by=$3::uuid and b.state='committed') as "committedBudgets"`,
    [actor.tenantId, caseId, actor.userId]);
  if (!state) throw new Error("Actual original evaluation state missing"); return state;
}
async function intentIds(page: Page) {
  return page.evaluate(prefix => Object.keys(sessionStorage).filter(key => key.startsWith(prefix)).map(key => {
    const value = JSON.parse(sessionStorage.getItem(key)!) as { caseId: string; runId: string | null; input: { modelId: string; requestId: string } };
    return { caseId: value.caseId, runId: value.runId, input: value.input };
  }), recoveryPrefix);
}
async function screenshot(page: Page, info: TestInfo, name: string, width: 1440 | 390) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const element of await page.locator(".kb-evaluation-result, .kb-eval-report, .kb-evaluation-recovery").all())
    expect(await element.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath(name + ".png"), fullPage: false });
}
async function closeDrawer(page: Page) {
  await drawer(page).getByRole("button", { name: "关闭结果读取", exact: true }).click(); await expect(drawer(page)).toHaveCount(0);
}

test("a successful paid start survives failed result reading and reload under its original IDs, then explicitly selected runs use their own sealed assessments", async ({ page }, info) => {
  const value = await owner("original-start-recovery"), observed = observe(page); let intercepted = 0;
  const failedPath: { value?: string } = {}, captured: { report?: KnowledgeEvaluationReport } = {};
  const failRead = async (route: Route) => {
    const actual = await route.fetch(); expect(actual.status()).toBe(200);
    captured.report = KnowledgeEvaluationReportSchema.parse(await actual.json()); failedPath.value = new URL(route.request().url()).pathname; intercepted++;
    await route.fulfill({ response: actual, status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic transport-only result read interruption" }) });
  };
  try {
    const source = await seedCard(value, "RECOVERY"); await value.fixture.setDataScope("self");
    await loginErp(page, "operator", "/knowledge?tab=governance"); await ready(page);
    const fixed = await createCase(page, source);
    await page.route("**/api/knowledge-governance/evaluation-runs/*", failRead, { times: 1 });
    expect(observed.starts).toEqual([]); const original = await start(page, value, fixed);
    await expect(drawer(page).getByRole("alert")).toContainText("知识服务未完成"); expect(intercepted).toBe(1);
    expect(captured.report?.id).toBe(original.id);
    await expect(evaluation(page).getByRole("region", { name: "本人原评测恢复", exact: true })).toContainText(original.id);
    expect(await intentIds(page)).toEqual([{ caseId: fixed.id, runId: original.id, input: original.input }]);
    await complete(value, captured.report!, source);
    expect(value.fixture.modelCalls()).toBe(1);
    const before = await exactState(value, fixed.id); expect(before).toEqual({ runs: 1, protocols: 1, assessments: 1, starts: 1, committedBudgets: 1 });
    value.proof.originalState = before; value.proof.originalRunId = original.id;
    await page.reload(); await ready(page);
    expect(await intentIds(page)).toEqual([{ caseId: fixed.id, runId: original.id, input: original.input }]);
    await evaluation(page).getByRole("button", { name: "只读取原评测结果", exact: true }).click();
    await expect(runRegion(page)).toContainText(original.id); await expect(runRegion(page)).toContainText(source.answer);
    await expect(runRegion(page)).toContainText("原完成事务已封存评分");
    const restored = await readReport(page, original.id);
    expect(restored.protocol).toMatchObject({ runId: original.id, modelId: value.fixture.modelId, dataScope: "self" });
    expect(restored.assessmentState).toBe("recorded"); expect(restored.assessment?.checks.every(check => check.status === "pass")).toBe(true);
    expect(restored.protocol?.requestChecksum).toBe(sha(canonicalJson({ version: 1, operation: "knowledge-evaluation-start", caseId: fixed.id, input: original.input })));
    expect(observed.starts).toEqual([{ caseId: fixed.id, input: original.input }]); expect(await exactState(value, fixed.id)).toEqual(before);
    const reason = "Synthetic human checked every stated fact and pinned citation " + randomUUID();
    await drawer(page).getByRole("combobox", { name: "事实性人工核验", exact: true }).selectOption("pass");
    await drawer(page).getByLabel("核验依据", { exact: true }).fill(reason);
    const reviewed = page.waitForResponse(response => new URL(response.url()).pathname === endpoint + `evaluation-runs/${original.id}/review` && response.request().method() === "POST");
    await drawer(page).getByRole("button", { name: "记录人工核验", exact: true }).click();
    const response = await reviewed; expect(response.status()).toBe(201);
    expect(ReviewKnowledgeEvaluationSchema.parse(response.request().postDataJSON())).toEqual({ result: "pass", reason });
    await expect(runRegion(page).getByRole("region", { name: "原评测人工核验记录", exact: true })).toContainText(reason);
    await screenshot(page, info, "knowledge-evaluation-original-desktop", 1440); await closeDrawer(page);
    await evaluation(page).getByRole("button", { name: "确认原运行编号并清除恢复副本", exact: true }).click();
    expect(await intentIds(page)).toEqual([]); expect(await exactState(value, fixed.id)).toEqual(before);
    const next = await start(page, value, fixed); expect(next.input.requestId).not.toBe(original.input.requestId);
    const pending = await readReport(page, next.id); await complete(value, pending, source);
    await closeDrawer(page);
    const row = evaluation(page).locator(".kb-row").filter({ hasText: fixed.label });
    await row.getByRole("button", { name: "结果与版本对比", exact: true }).click();
    const comparisonForm = drawer(page).getByRole("form", { name: "明确选择基线和候选运行", exact: true });
    await comparisonForm.getByLabel("基线运行 ID", { exact: true }).fill(original.id);
    await comparisonForm.getByLabel("候选运行 ID", { exact: true }).fill(next.id);
    const comparisonResponse = page.waitForResponse(result => new URL(result.url()).pathname === endpoint + "evaluation-comparisons");
    await comparisonForm.getByRole("button", { name: "读取并比较这两次原运行", exact: true }).click();
    const compared = await comparisonResponse; expect(compared.status()).toBe(200);
    const pair = KnowledgeEvaluationComparisonSchema.parse(await compared.json()); expect(pair).toMatchObject({ comparable: true, reasons: [] });
    expect(pair.baseline.id).toBe(original.id); expect(pair.candidate.id).toBe(next.id);
    const comparison = drawer(page).getByRole("region", { name: "两次原运行的受权比较", exact: true });
    await expect(comparison.getByRole("region", { name: "基线原评测", exact: true })).toContainText(original.id);
    await expect(comparison.getByRole("region", { name: "候选原评测", exact: true })).toContainText(next.id);
    await expect(runRegion(page)).toHaveCount(0);
    await screenshot(page, info, "knowledge-evaluation-comparison-mobile", 390);
    expect(observed.starts).toEqual([{ caseId: fixed.id, input: original.input }, { caseId: fixed.id, input: next.input }]);
    expect(value.fixture.modelCalls()).toBe(2); value.proof.finalState = await exactState(value, fixed.id);
    expect(observed.pageErrors).toEqual([]);
    expect(observed.consoleErrors).toEqual([{ path: failedPath.value, text: "Failed to load resource: the server responded with a status of 503 (Service Unavailable)" }]);
    value.proof.transportInterruptions = 1; value.proof.syntheticProviderCalls = 2;
  } finally {
    try { await page.unroute("**/api/knowledge-governance/evaluation-runs/*", failRead); }
    finally { await value.close(); }
  }
});

test("current scope narrowing clears original scores and local intent and rejects an older successful response without another paid start", async ({ page }, info) => {
  const value = await owner("current-scope-and-late-read"), observed = observe(page);
  let release: (() => void) | undefined, reached: (() => void) | undefined, settled: (() => void) | undefined;
  const held = new Promise<void>(resolveGate => { release = resolveGate; });
  const captured = new Promise<void>(resolveGate => { reached = resolveGate; });
  const flushed = new Promise<void>(resolveGate => { settled = resolveGate; });
  let capturedStatus = 0, delivered = false, cancelled = false, lateStarted = false, capturedIds: string[] = [], latePattern: string | undefined;
  const late = async (route: Route) => {
    lateStarted = true;
    try {
      const response = await route.fetch(); capturedStatus = response.status();
      capturedIds = KnowledgeEvaluationRunPageSchema.parse(await response.json()).items.map(item => item.id);
      reached?.(); await held;
      try { await route.fulfill({ response }); delivered = true; }
      catch { if (route.request().failure()) cancelled = true; else throw new Error("Delayed successful evaluation response failed without an actual cancellation"); }
    }
    finally { settled?.(); }
  };
  try {
    const source = await seedCard(value, "SCOPE"); await loginErp(page, "operator", "/knowledge?tab=governance"); await ready(page);
    const fixed = await createCase(page, source), original = await start(page, value, fixed);
    const pending = await readReport(page, original.id); await complete(value, pending, source);
    await closeDrawer(page);
    await evaluation(page).locator(".kb-row").filter({ hasText: fixed.label }).getByRole("button", { name: "结果与版本对比", exact: true }).click();
    await drawer(page).getByRole("button", { name: "读取原运行 " + original.id.slice(-8), exact: true }).click();
    await expect(runRegion(page)).toContainText("原完成事务已封存评分");
    await expect(runRegion(page)).toContainText(source.answer);
    expect((await readReport(page, original.id)).protocol?.dataScope).toBe("tenant");
    const reason = "SYNTHETIC-PRIVATE-REVIEW-DRAFT-" + randomUUID();
    await drawer(page).getByLabel("核验依据", { exact: true }).fill(reason);
    const path = endpoint + "evaluation-runs/" + original.id;
    latePattern = "**/api/knowledge-governance/evaluations/" + fixed.id + "/run-page?*";
    await page.route(latePattern, late, { times: 1 });
    await drawer(page).getByRole("button", { name: "重新读取原问题历史", exact: true }).click(); await captured;
    expect(capturedStatus).toBe(200); expect(capturedIds).toContain(original.id);
    await expect(runRegion(page)).toContainText(source.answer); await expect(drawer(page).getByRole("textbox", { name: "核验依据", exact: true })).toHaveValue(reason);
    await value.fixture.setDataScope("self");
    const identity = page.waitForResponse(response => new URL(response.url()).pathname === "/api/erp-auth/session" && response.request().method() === "GET");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    expect(((await (await identity).json()) as { dataScope: string }).dataScope).toBe("self");
    await expect(drawer(page)).toHaveCount(0); await ready(page);
    if (!release) throw new Error("Synthetic original evaluation read gate missing"); release();
    await flushed; expect(delivered || cancelled).toBe(true);
    await expect(page.locator(".kb-answer")).toHaveCount(0);
    await expect(page.getByText(reason, { exact: true })).toHaveCount(0); expect(await intentIds(page)).toEqual([]);
    const invalid = await page.request.get(path); expect(invalid.status()).toBe(403);
    const input = evaluation(page).getByLabel("原评测运行 ID", { exact: true }); await input.fill(original.id);
    const denied = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === "GET");
    await evaluation(page).getByRole("button", { name: "按原运行 ID 读取", exact: true }).click(); expect((await denied).status()).toBe(403);
    await expect(evaluation(page)).toContainText("原回答 历史和填写已清除");
    await expect(page.locator(".kb-answer")).toHaveCount(0); await expect(drawer(page)).toHaveCount(0);
    expect(observed.starts).toEqual([{ caseId: fixed.id, input: original.input }]); expect(value.fixture.modelCalls()).toBe(1);
    const state = await exactState(value, fixed.id); expect(state).toEqual({ runs: 1, protocols: 1, assessments: 1, starts: 1, committedBudgets: 1 });
    await screenshot(page, info, "knowledge-evaluation-revoked-mobile", 390);
    expect(observed.pageErrors).toEqual([]);
    expect(observed.consoleErrors).toEqual([{ path, text: "Failed to load resource: the server responded with a status of 403 (Forbidden)" }]);
    value.proof.runId = original.id; value.proof.currentScope = "self"; value.proof.originalScope = "tenant";
    value.proof.originalReadStatus = 403; value.proof.delayedResponseStatus = capturedStatus; value.proof.finalState = state;
  } finally {
    release?.();
    try { if (lateStarted) await flushed; if (latePattern) await page.unroute(latePattern, late); }
    finally { await value.close(); }
  }
});
