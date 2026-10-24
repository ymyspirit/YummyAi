import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Permission } from "@yummyai/authz/permissions";
import { connectDatabase, type DatabaseConnection } from "@yummyai/database";
import { KnowledgeFieldsSchema, type KnowledgeWorkspace } from "@yummyai/contracts/knowledge";
import { BenchmarkAttemptSchema, BenchmarkCommandReceiptSchema, BenchmarkDatasetFieldsSchema, BenchmarkExperimentSchema, BenchmarkReceiptSchema,
  BenchmarkReportSchema, BenchmarkVersionSchema, BENCHMARK_RULE_VERSION, StartBenchmarkAttemptSchema, type BenchmarkAttempt, type BenchmarkVersion } from "@yummyai/contracts/knowledge/benchmark";
import { KnowledgeEvaluationReportSchema } from "@yummyai/contracts/knowledge/governance";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";
import { knowledgeGovernanceFixture } from "./knowledge-governance-fixture";
import { centerApi } from "./order-centers-fixture";
import { actors, loginErp } from "./erp-identity-fixture";

function isolation() {
  const url = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const api = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid");
  if (!nonce || !process.env.ERP_FIXTURE_ACTORS || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) || api.port !== "8130" || process.env.E2E_ISOLATED_DAILY !== "1" ||
      process.env.E2E_KNOWLEDGE_BENCHMARK_ISOLATED !== "1" || process.env.E2E_KNOWLEDGE_EVALUATION_ISOLATED !== "1" ||
      process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || process.env.E2E_COMPILED_WEB !== "1" || process.env.WEB_AUTH_MODE !== "personal" ||
      process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`) throw new Error("Knowledge benchmark requires the exact compiled personal disposable nonce API and private bucket before connection");
  return { url, nonce };
}
const isolated = isolation(), endpoint = "/api/knowledge-governance/benchmarks/", intentPrefix = "yummyai.knowledge-benchmark.intent.v1:";
const owned = resolve(fileURLToPath(new URL("../../../", import.meta.url)), "tmp/knowledge-benchmark-20261021-a7d9e6c2/qa/browser", isolated.nonce);
const workspace = (page: Page) => page.getByRole("region", { name: "固定数据集与实验", exact: true });
const experiment = (page: Page) => page.getByRole("region", { name: "固定分母实验详情", exact: true });
const attemptRegion = (page: Page) => page.getByRole("region", { name: "原实验尝试结果", exact: true });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
type Owner = Awaited<ReturnType<typeof owner>>;
const unfinished = new Set<{ close(): Promise<void> }>();
async function owner(leaf: string) {
  isolation(); const requests: Record<string, unknown>[] = [];
  const fixture = await knowledgeGovernanceFixture(`benchmark-${leaf}`, { onModelRequest: request => requests.push(request) });
  const database: DatabaseConnection = connectDatabase(isolated.url.href);
  const proof: Record<string, unknown> = { leaf, nonce: isolated.nonce,
    admission: "Real personal OIDC and compiled Web, current membership, reviewed knowledge, fixed publication, native Assist/Durable processing, human minutes and report owners; only provider HTTP transport is synthetic",
    cleanupOwner: "This fixture restores its actual role scopes and permissions and closes connections; outer disposable runner deletes nonce database, bucket and identity resources" };
  let closed = false;
  const result = { fixture, database, requests, proof, async check() {
    if (closed || isolation().nonce !== isolated.nonce) throw new Error("Synthetic benchmark owner scope changed");
    const [row] = await database.client.unsafe<{ name: string }[]>("select current_database() as name");
    if (row?.name !== `order_daily_e2e_${isolated.nonce}`) throw new Error("Exact benchmark nonce database required");
  }, async close() {
    if (closed) return;
    const errors: string[] = [];
    try { await result.check(); await fixture.close(); proof.rolesRestored = true; } catch { errors.push("synthetic_roles_restore_failed"); }
    try { await database.client.end(); proof.connectionClosed = true; } catch { errors.push("owned_connection_close_failed"); }
    closed = true; unfinished.delete(result); proof.cleanupErrors = errors;
    await mkdir(owned, { recursive: true }); await writeFile(resolve(owned, leaf + ".json"), JSON.stringify(proof, null, 2) + "\n");
    if (errors.length) throw new Error("Knowledge benchmark cleanup incomplete: " + errors.join(","));
  } };
  unfinished.add(result); try { await result.check(); return result; } catch (error) { await result.close(); throw error; }
}
test.afterAll(async () => { for (const value of [...unfinished]) await value.close(); });
async function ready(page: Page) {
  await expect(page.getByRole("heading", { name: "运营知识库", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "治理中心", exact: true }).click();
  await page.getByRole("button", { name: "固定数据集与实验", exact: true }).click();
  await expect(workspace(page)).toBeVisible();
}
async function source(index: number) {
  const token = () => randomUUID().replaceAll("-", "").replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + Number.parseInt(digit, 16)));
  const title = `SYNTHETIC-BENCHMARK-${index}-${token()}`, answer = `Synthetic fixed source ${token()}`;
  const fields = KnowledgeFieldsSchema.parse({ title, summary: "Synthetic fixed source", body: `${answer} Quantity 3 Unit price 12.34 USD`,
    topic: "operations", platform: "amazon", market: "US", spuId: null, sourceType: "team", sourceLabel: "Synthetic approved benchmark bibliography", sourceUrl: "",
    owner: "Synthetic evaluator", verifiedOn: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date()), reviewDueOn: "2099-12-31", tags: [] });
  const created = await centerApi<{ id: string }>("knowledge/create", { fields, expectedRevision: 0, reason: "Synthetic benchmark fixture source", requestId: randomUUID() });
  for (const operation of ["submit", "publish"] as const) {
    const card = (await centerApi<KnowledgeWorkspace>("knowledge/workspace")).entries.find(row => row.id === created.id);
    if (!card) throw new Error("Synthetic actual source card missing");
    await centerApi(`knowledge/${card.id}/${operation}`, { expectedRevision: card.revision, version: card.latestVersion, reason: "Synthetic independently checked original source", requestId: randomUUID() });
  }
  return { id: created.id, title, answer };
}
async function posted(page: Page, path: string, action: () => Promise<void>) {
  const waiting = page.waitForResponse(response => new URL(response.url()).pathname === endpoint + path && response.request().method() === "POST", { timeout: 15_000 });
  const [response] = await Promise.all([waiting, action()]); expect(response.status()).toBe(201);
  return { receipt: BenchmarkReceiptSchema.parse(await response.json()), input: response.request().postDataJSON() as Record<string, unknown> };
}
async function currentAuthorityHeaders(page: Page) {
  const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200);
  return { "x-yummyai-context-authority": erpSessionAuthority(ErpSessionViewSchema.parse(await response.json())) };
}
async function personalGet(page: Page, path: string) {
  return page.request.get(endpoint + path, { headers: await currentAuthorityHeaders(page) });
}
async function personalPost(page: Page, path: string, data: unknown) {
  const response = await page.request.post(endpoint + path, { data, headers: { origin: new URL(page.url()).origin, ...await currentAuthorityHeaders(page) } });
  expect(response.status()).toBe(201); return BenchmarkReceiptSchema.parse(await response.json());
}
async function readAttempt(page: Page, id: string) {
  const response = await personalGet(page, "attempts/" + id); expect(response.status()).toBe(200); return BenchmarkAttemptSchema.parse(await response.json());
}
async function complete(page: Page, value: Owner, attempt: BenchmarkAttempt, version: BenchmarkVersion, sources: Awaited<ReturnType<typeof source>>[]) {
  if (!attempt.evaluationRunId) throw new Error("Synthetic benchmark completion requires the actual native evaluation");
  const response = await page.request.get("/api/knowledge-governance/evaluation-runs/" + attempt.evaluationRunId); expect(response.status()).toBe(200);
  const report = KnowledgeEvaluationReportSchema.parse(await response.json()), item = version.items.find(row => row.id === attempt.itemId);
  if (!item) throw new Error("Actual fixed benchmark item missing");
  const original = sources.find(row => item.fields.evaluation.requiredEntryIds.includes(row.id));
  const pin = item.sourcePins.find(row => row.entryId === original?.id);
  const pinned = report.answer.knowledge.find(row => row.sourceId === pin?.sourceId && row.versionId === pin?.versionId && row.checksum === pin?.checksum);
  if (!original || !pinned) throw new Error("Actual published source reference required");
  await value.fixture.analyze(report.answer.id, { summary: original.answer, findings: [{ title: "Synthetic fixed original source", detail: original.answer, kind: "fact", severity: "info",
    location: null, evidence: [{ sourceId: pinned.sourceId, detail: "Synthetic explicitly pinned source version" }] }], directions: [], matches: [], missingInformation: [],
    typedAnswers: [{ key: "total", value: "37.02", unit: "money", currency: "USD", evidence: [{ sourceId: "benchmark-input:total", detail: "Original supplied 3 and 12.34" }] }] });
  const done = await readAttempt(page, attempt.id); expect(done).toMatchObject({ state: "completed", assessment: { hardPass: true }, resultAvailable: true }); return done;
}
async function screenshot(page: Page, info: TestInfo, label: string, width: 1440 | 390) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const region of await page.locator(".kb-benchmark-pairs, .kb-benchmark-notice, .kb-benchmark-section").all())
    expect(await region.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath(label + ".png"), fullPage: false });
}
async function createInUi(page: Page, value: Owner, sources: Awaited<ReturnType<typeof source>>[]) {
  await workspace(page).getByRole("button", { name: "新建数据集草稿", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "新建固定数据集草稿", exact: true }), name = `SYNTHETIC-FIXED-DATASET-${randomUUID()}`;
  await drawer.getByLabel("数据集名称", { exact: true }).fill(name); await drawer.getByLabel("数据集说明", { exact: true }).fill("Synthetic fixed arithmetic and original knowledge comparison");
  for (const [index, original] of sources.entries()) {
    if (index > 0) {
      await drawer.getByRole("button", { name: "添加固定样本", exact: true }).click();
      await drawer.locator(`details:has(> [role="group"][aria-label="样本 ${index + 1}"]) > summary`).click();
    }
    const item = drawer.getByRole("group", { name: `样本 ${index + 1}`, exact: true });
    await item.getByLabel("样本稳定标识", { exact: true }).fill(`sample_${index + 1}`); await item.getByLabel("题目名称", { exact: true }).fill(`Synthetic original case ${index + 1}`);
    await item.getByLabel("固定业务问题", { exact: true }).fill(original.title); await item.getByRole("combobox", { name: "主题", exact: true }).selectOption("operations");
    await item.getByRole("combobox", { name: "平台", exact: true }).selectOption("amazon"); await item.getByLabel("站点", { exact: true }).fill("US");
    await item.getByLabel("期望事实 每行一项", { exact: true }).fill(original.answer); await item.getByLabel("禁止表述 每行一项", { exact: true }).fill("Synthetic unsupported guarantee");
    await item.getByLabel("必需知识卡 ID 每行一个", { exact: true }).fill(original.id); await item.getByRole("button", { name: "添加结构化数值断言", exact: true }).click();
    const numeric = item.getByRole("group", { name: "数值断言 1", exact: true });
    await numeric.getByLabel("数值答案标识", { exact: true }).fill("total"); await numeric.getByRole("combobox", { name: "白名单运算", exact: true }).selectOption("product");
    await numeric.getByLabel("精确操作数 每行一个", { exact: true }).fill("3\n12.34"); await numeric.getByLabel("小数位数", { exact: true }).fill("2");
    await numeric.getByLabel("单位", { exact: true }).fill("money"); await numeric.getByLabel("币种 无币种留空", { exact: true }).fill("USD"); await numeric.getByLabel("独立预期数值", { exact: true }).fill("37.02");
  }
  await drawer.getByLabel("草稿保存依据", { exact: true }).fill("Synthetic reviewed original sources and independent arithmetic expectations");
  const saved = await posted(page, "datasets", () => drawer.getByRole("button", { name: "保存数据集草稿", exact: true }).click());
  expect(BenchmarkDatasetFieldsSchema.parse(saved.input.fields).items).toHaveLength(2);
  await drawer.getByRole("button", { name: "读取已保存数据集并关闭填写", exact: true }).click(); await expect(drawer).toHaveCount(0);
  const publish = page.getByRole("form", { name: "发布固定数据集", exact: true });
  await publish.getByLabel("依据保留天数", { exact: true }).fill("7"); await publish.getByLabel("发布核对依据", { exact: true }).fill("Synthetic fixed sources and two sample manifest explicitly checked");
  const published = await posted(page, `datasets/${saved.receipt.id}/publish`, () => publish.getByRole("button", { name: "核对并发布此数据集修订", exact: true }).click());
  await workspace(page).getByRole("button", { name: "读取实际发布版本", exact: true }).click();
  const response = await personalGet(page, "versions/" + published.receipt.id); expect(response.status()).toBe(200); const version = BenchmarkVersionSchema.parse(await response.json());
  expect(version.items).toHaveLength(2);
  for (const [index, item] of version.items.entries()) {
    expect(item.fields.evaluation.requiredEntryIds).toEqual([sources[index]!.id]);
    expect(item.sourcePins.map(row => row.entryId)).toContain(sources[index]!.id);
  }
  expect(value.fixture.modelCalls()).toBe(0); await workspace(page).getByRole("button", { name: "按此固定版本准备实验", exact: true }).click();
  const form = page.getByRole("form", { name: "创建固定版本实验", exact: true });
  await form.getByLabel("实验名称", { exact: true }).fill(`SYNTHETIC-FIXED-EXPERIMENT-${randomUUID()}`);
  await form.getByRole("combobox", { name: "候选评测模型", exact: true }).selectOption(value.fixture.modelId);
  await form.getByLabel("每题候选尝试上限", { exact: true }).fill("2"); await form.getByLabel("实验创建依据", { exact: true }).fill("Synthetic same manifest original baseline and candidate comparison");
  const created = await posted(page, "experiments", () => form.getByRole("button", { name: "创建实验并运行免费规则基线", exact: true }).click());
  await workspace(page).getByRole("button", { name: "读取实际实验和规则基线", exact: true }).click();
  await expect(experiment(page)).toContainText(created.receipt.id); await expect(experiment(page).getByRole("list", { name: "全部固定样本结果", exact: true }).locator("li")).toHaveCount(2);
  expect(value.fixture.modelCalls()).toBe(0); return { saved: saved.receipt, version, experimentId: created.receipt.id };
}
async function openAttempt(page: Page, id: string) {
  const form = page.getByRole("form", { name: "按原尝试 ID 读取", exact: true }); await form.getByLabel("原尝试 ID", { exact: true }).fill(id);
  await form.getByRole("button", { name: "读取原实验尝试", exact: true }).click();
  if (await experiment(page).count()) await experiment(page).getByRole("button", { name: "重新读取实验与成本", exact: true }).click();
  await expect(attemptRegion(page)).toContainText(id);
}
async function reviewInUi(page: Page) {
  const form = page.getByRole("form", { name: "本次人工核验与实际分钟", exact: true }); await form.getByRole("combobox", { name: "实际人工结论", exact: true }).selectOption("pass");
  await form.getByLabel("本次实际核验分钟", { exact: true }).fill("1.500"); await form.getByLabel("本次小时费率 USD 未知留空", { exact: true }).fill("120");
  await form.getByLabel("事实核验与耗时依据", { exact: true }).fill("Synthetic actual original evidence and numeric output reviewed");
  const id = (await attemptRegion(page).locator("dt").filter({ hasText: /^原尝试 ID$/ }).locator("..").locator("dd").innerText()).trim();
  await posted(page, `attempts/${id}/review`, () => form.getByRole("button", { name: "追加本次人工核验记录", exact: true }).click());
  await workspace(page).getByRole("button", { name: "确认原核验回执并重读", exact: true }).click();
  await expect(attemptRegion(page).getByRole("region", { name: "最近一次实际人工核验", exact: true })).toContainText("人工通过");
}
async function intentRecords(page: Page) {
  return page.evaluate(prefix => Object.keys(sessionStorage).filter(key => key.startsWith(prefix)).map(key => JSON.parse(sessionStorage.getItem(key)!)) as Array<{
    operation: string; requestId: string; receiptId: string | null; parentId: string | null; requestChecksum: string; attemptInput?: ReturnType<typeof StartBenchmarkAttemptSchema.parse> }>, intentPrefix);
}
function observe(page: Page) {
  const posts: Array<{ path: string; input: unknown }> = [], errors: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith(endpoint) && request.method() === "POST") posts.push({ path, input: request.postDataJSON() }); });
  page.on("pageerror", error => errors.push(error.message)); return { posts, errors };
}

test("publishes fixed original samples, restores a lost paid-intent receipt after reload and seals all-attempt estimated costs without another model call", async ({ page }, info) => {
  const value = await owner("fixed-arms"), observed = observe(page);
  try {
    const sources = [await source(1), await source(2)]; await loginErp(page, "operator", "/knowledge"); await ready(page);
    const scene = await createInUi(page, value, sources); value.proof.datasetId = scene.saved.id; value.proof.versionId = scene.version.id; value.proof.experimentId = scene.experimentId;
    let captured: { receipt: ReturnType<typeof BenchmarkReceiptSchema.parse>; input: ReturnType<typeof StartBenchmarkAttemptSchema.parse> } | undefined, handled = false, routeError: unknown;
    const pattern = "**" + endpoint + `experiments/${scene.experimentId}/attempts/start`;
    const lose: (route: Route) => Promise<void> = async route => {
      try { const input = StartBenchmarkAttemptSchema.parse(route.request().postDataJSON()), response = await route.fetch(); expect(response.status()).toBe(201);
        captured = { input, receipt: BenchmarkReceiptSchema.parse(await response.json()) }; await route.abort("failed"); }
      catch (error) { routeError = error; } finally { handled = true; }
    };
    await page.route(pattern, lose);
    try {
      await experiment(page).getByRole("button", { name: "准备本题新的付费尝试 sample_1", exact: true }).click();
      const drawer = page.getByRole("dialog", { name: "核对本题新的付费尝试", exact: true });
      await drawer.getByRole("checkbox", { name: "我已核对原样本及最新尝试 明确开始这一次新的付费调用", exact: true }).check();
      await drawer.getByRole("button", { name: "确认本题新的付费尝试", exact: true }).click();
      await expect.poll(() => handled, { timeout: 30_000 }).toBe(true); if (routeError) throw routeError; if (!captured) throw new Error("Actual committed candidate receipt missing");
      await expect(drawer.getByRole("button", { name: "按固定正文和原编号重试", exact: true })).toBeEnabled();
    } finally { await expect.poll(() => handled, { timeout: 30_000 }).toBe(true); await page.unroute(pattern, lose); }
    if (!captured) throw new Error("Actual original paid intent unavailable");
    const original = captured; const marker = (await intentRecords(page)).find(row => row.operation === "attempt.start" && row.requestId === original.input.requestId);
    expect(marker).toMatchObject({ parentId: scene.experimentId, attemptInput: original.input });
    expect(JSON.stringify(marker)).not.toContain(sources[0]!.answer); expect(JSON.stringify(marker)).not.toContain("expectedValue");
    expect(value.fixture.modelCalls()).toBe(0); expect(observed.posts.filter(row => row.path.endsWith("/attempts/start"))).toHaveLength(1);
    page.once("dialog", dialog => void dialog.accept()); await page.reload(); await ready(page);
    const recovery = page.getByRole("article", { name: "原评测请求 " + original.input.requestId, exact: true });
    const requestResponse = page.waitForResponse(response => new URL(response.url()).pathname === endpoint + "requests/" + original.input.requestId && response.request().method() === "GET");
    await recovery.getByRole("button", { name: "只读取原命令回执", exact: true }).click();
    const recoveredResponse = await requestResponse; expect(recoveredResponse.status()).toBe(200);
    expect(BenchmarkCommandReceiptSchema.parse(await recoveredResponse.json()).receipt).toEqual(original.receipt);
    await recovery.getByRole("button", { name: "读取原登记结果", exact: true }).click();
    await expect(attemptRegion(page)).toContainText(original.receipt.id); await expect(attemptRegion(page)).toContainText("排队中");
    await workspace(page).getByRole("button", { name: "读取此尝试所属原实验", exact: true }).click(); await expect(experiment(page)).toContainText(scene.experimentId);
    const freshRecovery = page.getByRole("article", { name: "原评测请求 " + original.input.requestId, exact: true });
    await freshRecovery.getByRole("button", { name: "确认原回执并清除恢复标识", exact: true }).click();
    const first = await complete(page, value, await readAttempt(page, original.receipt.id), scene.version, sources);
    await openAttempt(page, first.id); await expect(attemptRegion(page)).toContainText("原硬检查通过"); await reviewInUi(page);
    await experiment(page).getByRole("button", { name: "准备本题新的付费尝试 sample_2", exact: true }).click();
    const nextDrawer = page.getByRole("dialog", { name: "核对本题新的付费尝试", exact: true });
    await nextDrawer.getByRole("checkbox", { name: "我已核对原样本及最新尝试 明确开始这一次新的付费调用", exact: true }).check();
    const second = await posted(page, `experiments/${scene.experimentId}/attempts/start`, () => nextDrawer.getByRole("button", { name: "确认本题新的付费尝试", exact: true }).click());
    await nextDrawer.getByRole("button", { name: "读取实际原尝试与结果", exact: true }).click(); await expect(nextDrawer).toHaveCount(0);
    expect((await intentRecords(page)).filter(row => row.operation === "attempt.start")).toEqual([]);
    await complete(page, value, await readAttempt(page, second.receipt.id), scene.version, sources); await openAttempt(page, second.receipt.id); await reviewInUi(page);
    await expect(experiment(page).getByRole("list", { name: "全部固定样本结果", exact: true }).locator("li").filter({ hasText: "本题最新尝试符合原合格口径" })).toHaveCount(2);
    const costs = page.getByRole("region", { name: "实验成本与封存报告", exact: true }); await costs.getByRole("button", { name: "登记候选累计存储维护", exact: true }).click();
    const expense = page.getByRole("dialog", { name: "登记累计存储维护成本", exact: true }); await expense.getByLabel("累计存储费用 USD", { exact: true }).fill("0.01");
    await expense.getByLabel("累计维护费用 USD", { exact: true }).fill("0.25"); await expense.getByLabel("实际累计分摊依据", { exact: true }).fill("Synthetic cumulative expense over both actual paid attempts and human reviews");
    await expense.getByRole("checkbox", { name: "我已按上述活动和期间核对累计存储维护值 未知项保持空白", exact: true }).check();
    await posted(page, `experiments/${scene.experimentId}/expenses`, () => expense.getByRole("button", { name: "登记原活动的累计成本", exact: true }).click());
    await expense.getByRole("button", { name: "确认成本登记回执并重读摘要", exact: true }).click(); await expect(expense).toHaveCount(0);
    await expect(costs.getByRole("region", { name: "候选全部尝试成本", exact: true })).toContainText("6.26042000");
    await expect(costs.getByRole("region", { name: "候选全部尝试成本", exact: true })).toContainText("仅估算");
    const seal = costs.getByRole("form", { name: "封存实验报告", exact: true }); await seal.getByLabel("报告封存依据", { exact: true }).fill("Synthetic original fixed denominator and all actual attempts as of sealing");
    const sealed = await posted(page, `experiments/${scene.experimentId}/reports`, () => seal.getByRole("button", { name: "明确封存本次实验报告", exact: true }).click());
    await costs.getByRole("button", { name: "读取实际封存报告", exact: true }).click(); await expect(page.getByRole("region", { name: "不可变实验报告", exact: true })).toContainText(sealed.receipt.id);
    const reportResponse = await personalGet(page, "reports/" + sealed.receipt.id); expect(reportResponse.status()).toBe(200); const report = BenchmarkReportSchema.parse(await reportResponse.json());
    expect(report.attemptIds).toHaveLength(4); expect(report.reviewIds).toHaveLength(2); expect(report.summary.candidate).toMatchObject({ qualifiedItems: 2, state: "estimated", allAttempts: 2, totalUsd: "6.26042000", unitQualifiedCostUsd: null });
    const actor = actors().operator, [counts] = await value.database.client.unsafe<{ attempts: number; natives: number; assessments: number }[]>(`select
      (select count(*)::int from knowledge_benchmark_attempts where tenant_id=$1::uuid and experiment_id=$2::uuid and arm='candidate') as attempts,
      (select count(*)::int from knowledge_evaluation_runs e join knowledge_benchmark_attempts a on a.evaluation_run_id=e.id where a.tenant_id=$1::uuid and a.experiment_id=$2::uuid) as natives,
      (select count(*)::int from knowledge_benchmark_assessments s join knowledge_benchmark_attempts a on a.id=s.attempt_id where a.tenant_id=$1::uuid and a.experiment_id=$2::uuid) as assessments`, [actor.tenantId, scene.experimentId]);
    expect(counts).toEqual({ attempts: 2, natives: 2, assessments: 4 }); expect(value.fixture.modelCalls()).toBe(2);
    expect(value.requests.every(body => !JSON.stringify(body).includes("expectedValue") && !JSON.stringify(body).includes("37.02"))).toBe(true);
    expect(observed.posts.filter(row => row.path.endsWith("/attempts/start"))).toHaveLength(2); expect(observed.errors).toEqual([]);
    value.proof.reportId = report.id; value.proof.originalReportChecksum = sha(JSON.stringify(report)); value.proof.actualCounts = counts;
    await screenshot(page, info, "fixed-original-report-desktop", 1440); await screenshot(page, info, "fixed-original-report-mobile", 390);
  } finally { await value.close(); }
});

test("reads original fixed experiments with Read alone and clears private data plus delayed answers when the current source scope is revoked", async ({ page }, info) => {
  const value = await owner("current-authority"), observed = observe(page);
  try {
    const originals = [await source(1), await source(2)]; await loginErp(page, "operator", "/knowledge"); await ready(page);
    const fields = BenchmarkDatasetFieldsSchema.parse({ name: `SYNTHETIC-PRIVATE-BENCHMARK-${randomUUID()}`, description: "Synthetic current authority fixture",
      items: originals.map((original, index) => ({ key: `sample_${index + 1}`, role: "knowledge_answer", evaluation: { label: `Synthetic private case ${index + 1}`,
        search: { query: original.title, topic: "operations", platform: "amazon", market: "US", spuIds: [] }, expectedFacts: [original.answer], forbiddenClaims: ["Synthetic unsupported guarantee"], requiredEntryIds: [original.id], expectRefusal: false },
        calculations: [{ key: "total", operator: "product", operands: ["3", "12.34"], scale: 2, unit: "money", currency: "USD", expectedValue: "37.02" }] })) });
    const saved = await personalPost(page, "datasets", { fields, expectedRevision: 0, reason: "Synthetic personal private dataset", requestId: randomUUID() });
    const published = await personalPost(page, `datasets/${saved.id}/publish`, { expectedRevision: 1, retentionDays: 7, reason: "Synthetic source ownership and fixed manifest checked", requestId: randomUUID() });
    const versionResponse = await personalGet(page, "versions/" + published.id); expect(versionResponse.status()).toBe(200); const version = BenchmarkVersionSchema.parse(await versionResponse.json());
    const created = await personalPost(page, "experiments", { datasetVersionId: version.id, baselineVersion: BENCHMARK_RULE_VERSION, label: `SYNTHETIC-PRIVATE-EXPERIMENT-${randomUUID()}`,
      modelId: value.fixture.modelId, maxAttemptsPerItem: 2, reason: "Synthetic current authority owner setup", requestId: randomUUID() });
    const started = await personalPost(page, `experiments/${created.id}/attempts/start`, { itemId: version.items[0]!.id, expectedLatestAttemptId: null, confirmNewPaidAttempt: true, requestId: randomUUID() });
    await complete(page, value, await readAttempt(page, started.id), version, originals); const calls = value.fixture.modelCalls(), posts = observed.posts.length;
    await value.fixture.setPermissions([Permission.WorkflowRead]); await page.reload(); await ready(page);
    await workspace(page).getByRole("button", { name: "实验 尝试与成本报告", exact: true }).click();
    const read = page.getByRole("form", { name: "按原实验 ID 读取", exact: true }); await read.getByLabel("原实验 ID", { exact: true }).fill(created.id);
    await read.getByRole("button", { name: "读取原实验", exact: true }).click(); await expect(experiment(page)).toContainText(created.id); await openAttempt(page, started.id);
    await expect(attemptRegion(page).getByRole("region", { name: "本次受权读取原答案", exact: true })).toContainText(originals[0]!.answer);
    await expect(workspace(page).getByRole("button", { name: /^准备本题新的付费尝试 / })).toHaveCount(0);
    await expect(workspace(page).getByRole("form", { name: "本次人工核验与实际分钟", exact: true })).toHaveCount(0);
    const scopeRead = await personalGet(page, "experiments/" + created.id); expect(scopeRead.status()).toBe(200); expect(BenchmarkExperimentSchema.parse(await scopeRead.json()).id).toBe(created.id);
    const forbidden = await page.request.post(endpoint + `attempts/${started.id}/review`, { headers: { origin: new URL(page.url()).origin, ...await currentAuthorityHeaders(page) }, data: { expectedReviewId: null, decision: "pass", minutes: "1", hourlyUsd: "120", reason: "Synthetic denied review", requestId: randomUUID() } }); expect(forbidden.status()).toBe(403);
    const pattern = "**" + endpoint + "attempts/" + started.id; let release: (() => void) | undefined, returned = false, fetched = false, routeError: unknown;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const delayed = async (route: Route) => {
      try { const response = await route.fetch(); expect(response.status()).toBe(200); const raw = BenchmarkAttemptSchema.parse(await response.json()); expect(raw.result?.summary).toBe(originals[0]!.answer);
        fetched = true; await gate; await route.fulfill({ response }); }
      catch (error) { routeError = error; } finally { returned = true; }
    };
    await page.route(pattern, delayed);
    try {
      await workspace(page).getByRole("button", { name: "读取此尝试所属原实验", exact: true }).click();
      // A real original-ID read, not a mocked record or assessment. A different
      // selected ID first makes the second click issue the same original path.
      const baseline = BenchmarkExperimentSchema.parse(await scopeRead.json()).cells[0]!.baselineAttemptId;
      await openAttempt(page, baseline);
      const form = page.getByRole("form", { name: "按原尝试 ID 读取", exact: true }); await form.getByLabel("原尝试 ID", { exact: true }).fill(started.id);
      await form.getByRole("button", { name: "读取原实验尝试", exact: true }).click();
      await expect.poll(() => fetched, { timeout: 15_000 }).toBe(true);
      await value.fixture.setDataScope("self"); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(attemptRegion(page)).toHaveCount(0); await expect(experiment(page)).toHaveCount(0);
      await expect(page.getByRole("region", { name: "知识详情", exact: true })).toBeVisible();
      const sessionResponse = await page.request.get("/api/erp-auth/session"); expect(sessionResponse.status()).toBe(200);
      const narrowed = ErpSessionViewSchema.parse(await sessionResponse.json());
      expect(narrowed.permissions).toContain(Permission.WorkflowRead); expect(narrowed.dataScope).toBe("self");
      expect(narrowed.permissionScopes?.[Permission.WorkflowRead] ?? narrowed.dataScope).toBe("self");
      if (!release) throw new Error("Synthetic delayed original answer gate missing"); release(); await expect.poll(() => returned, { timeout: 15_000 }).toBe(true); if (routeError) throw routeError;
      const [currentList] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === endpoint + "datasets" && response.request().method() === "GET" &&
          response.request().headers()["x-yummyai-context-authority"] === erpSessionAuthority(narrowed), { timeout: 15_000 }),
        ready(page),
      ]);
      expect([403, 409]).toContain(currentList.status());
      await expect(attemptRegion(page)).toHaveCount(0);
      await expect(workspace(page).getByText(originals[0]!.answer, { exact: false })).toHaveCount(0); await expect(experiment(page)).toHaveCount(0);
      const denied = await personalGet(page, "attempts/" + started.id); expect([403, 409]).toContain(denied.status());
      value.proof.narrowedReadScope = "self"; value.proof.currentListStatus = currentList.status(); value.proof.currentAttemptStatus = denied.status();
    } finally { release?.(); await expect.poll(() => returned, { timeout: 15_000 }).toBe(true); await page.unroute(pattern, delayed); }
    expect(value.fixture.modelCalls()).toBe(calls); expect(observed.posts).toHaveLength(posts); expect(observed.errors).toEqual([]);
    expect((await intentRecords(page)).length).toBe(0); value.proof.originalAttemptId = started.id; value.proof.providerCallsUnchanged = calls;
    await screenshot(page, info, "revoked-original-private-mobile", 390);
  } finally { await value.close(); }
});
