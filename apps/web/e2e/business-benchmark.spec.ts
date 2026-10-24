import { expect, test, type Locator, type Page, type Route, type TestInfo } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { Permission } from "@yummyai/authz/permissions";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AssistTaskBasisSchema } from "@yummyai/contracts/ai/task-workspace";
import { BenchmarkAttemptSchema, BenchmarkCommandReceiptSchema, BenchmarkCostSummarySchema, BenchmarkDatasetFieldsSchema,
  BenchmarkExperimentSchema, BenchmarkReceiptSchema, BenchmarkReportSchema, BenchmarkVersionSchema, BusinessBenchmarkCaseSchema,
  BUSINESS_BENCHMARK_RULE_VERSION, StartBenchmarkAttemptSchema, type BenchmarkAttempt, type BenchmarkVersion } from "@yummyai/contracts/knowledge/benchmark";
import { actors, loginErp } from "./erp-identity-fixture";
import { businessBenchmarkBrowser, closeBusinessBenchmarkBrowsers, requireBusinessBenchmarkBrowser } from "./business-benchmark-fixture";

requireBusinessBenchmarkBrowser();
const endpoint = "/api/knowledge-governance/benchmarks/", intentPrefix = "yummyai.knowledge-benchmark.intent.v1:";
const workspace = (page: Page) => page.getByRole("region", { name: "固定数据集与实验", exact: true });
const experiment = (page: Page) => page.getByRole("region", { name: "固定分母实验详情", exact: true });
const attemptRegion = (page: Page) => page.getByRole("region", { name: "原实验尝试结果", exact: true });
type Owner = Awaited<ReturnType<typeof businessBenchmarkBrowser>>;
type Source = Awaited<ReturnType<Owner["sources"]>>[number];
test.afterAll(closeBusinessBenchmarkBrowsers);

async function ready(page: Page) {
  await expect(page.getByRole("heading", { name: "运营知识库", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "治理中心", exact: true }).click();
  await page.getByRole("button", { name: "固定数据集与实验", exact: true }).click();
  await expect(workspace(page)).toBeVisible();
}
async function authorityHeaders(page: Page) {
  const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200);
  return { "x-yummyai-context-authority": erpSessionAuthority(ErpSessionViewSchema.parse(await response.json())) };
}
async function personalGet(page: Page, path: string) { return page.request.get(endpoint + path, { headers: await authorityHeaders(page) }); }
async function personalPost(page: Page, path: string, data: unknown, status = 201) {
  const response = await page.request.post(endpoint + path, { data, headers: { origin: new URL(page.url()).origin, ...await authorityHeaders(page) } });
  expect(response.status()).toBe(status); return response;
}
async function posted(page: Page, path: string, action: () => Promise<void>) {
  const waiting = page.waitForResponse(response => new URL(response.url()).pathname === endpoint + path && response.request().method() === "POST", { timeout: 20_000 });
  const [response] = await Promise.all([waiting, action()]); expect(response.status()).toBe(201);
  return { receipt: BenchmarkReceiptSchema.parse(await response.json()), input: response.request().postDataJSON() as Record<string, unknown> };
}
async function readAttempt(page: Page, id: string) {
  const response = await personalGet(page, "attempts/" + id); expect(response.status()).toBe(200); return BenchmarkAttemptSchema.parse(await response.json());
}
async function openAttempt(page: Page, id: string) {
  const form = workspace(page).getByRole("form", { name: "按原尝试 ID 读取", exact: true });
  await form.getByRole("textbox", { name: "原尝试 ID", exact: true }).fill(id);
  if (await experiment(page).count()) await experiment(page).getByRole("button", { name: "重新读取实验与成本", exact: true }).click();
  await form.getByRole("button", { name: "读取原实验尝试", exact: true }).click();
  await expect(attemptRegion(page)).toContainText(id);
}
async function review(page: Page, id: string) {
  const form = workspace(page).getByRole("form", { name: "本次人工核验与实际分钟", exact: true });
  await form.getByRole("combobox", { name: "实际人工结论", exact: true }).selectOption("pass");
  await form.getByRole("textbox", { name: "本次实际核验分钟", exact: true }).fill("1.500");
  await form.getByRole("textbox", { name: "本次小时费率 USD 未知留空", exact: true }).fill("120");
  await form.getByRole("textbox", { name: "事实核验与耗时依据", exact: true }).fill("Synthetic original facts and unknown quantities manually checked; phrase matching is not monetary or purchasing optimality proof");
  await posted(page, `attempts/${id}/review`, () => form.getByRole("button", { name: "追加本次人工核验记录", exact: true }).click());
  await workspace(page).getByRole("button", { name: "确认原核验回执并重读", exact: true }).click();
  await expect(attemptRegion(page).getByRole("region", { name: "最近一次实际人工核验", exact: true })).toContainText("人工通过");
}
async function intents(page: Page) {
  return page.evaluate(prefix => Object.keys(sessionStorage).filter(key => key.startsWith(prefix)).map(key => JSON.parse(sessionStorage.getItem(key)!)) as Array<{
    requestId: string; operation: string; receiptId: string | null; parentId: string | null; requestChecksum: string; attemptInput?: ReturnType<typeof StartBenchmarkAttemptSchema.parse> }>, intentPrefix);
}
function observe(page: Page) {
  const posts: Array<{ path: string; input: unknown }> = [], pageErrors: string[] = [], consoleErrors: Array<{ text: string; path: string }> = [];
  const failed: Array<{ path: string; error: string }> = [], responses: Array<{ path: string; status: number }> = [];
  page.on("request", request => { const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path.startsWith(endpoint)) posts.push({ path, input: request.postDataJSON() }); });
  page.on("response", response => { const path = new URL(response.url()).pathname; if (path.startsWith(endpoint)) responses.push({ path, status: response.status() }); });
  page.on("requestfailed", request => failed.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText ?? "" }));
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") { let path = "";
    try { path = new URL(message.location().url).pathname; } catch { /* Unknown errors remain unallowlisted. */ }
    consoleErrors.push({ text: message.text(), path }); } });
  return { posts, pageErrors, consoleErrors, failed, responses };
}
async function screenshot(page: Page, info: TestInfo, label: string, width: 1440 | 390, target: Locator) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 }); await target.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const region of await page.locator(".kb-benchmark-pairs, .kb-benchmark-notice, .kb-benchmark-section").all())
    if (await region.isVisible()) expect(await region.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath(label + ".png"), fullPage: false });
}

async function publishInUi(page: Page, owner: Owner, sources: Source[]) {
  const forbidden = `SYNTHETIC_ASSERTION_ONLY_${randomUUID()}`;
  await workspace(page).getByRole("button", { name: "新建数据集草稿", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "新建固定数据集草稿", exact: true });
  await drawer.getByRole("combobox", { name: "固定样本类型", exact: true }).selectOption("business");
  await drawer.getByRole("textbox", { name: "数据集名称", exact: true }).fill(`SYNTHETIC-BUSINESS-DATASET-${randomUUID()}`);
  await drawer.getByRole("textbox", { name: "数据集说明", exact: true }).fill("Synthetic real stock and immutable finance sources, known and missing pairs, two original business roles");
  const basisPins: string[] = [];
  for (const [index, source] of sources.entries()) {
    if (index > 0) { await drawer.getByRole("button", { name: "添加固定样本", exact: true }).click();
      await drawer.locator(`details:has(> [role="group"][aria-label="样本 ${index + 1}"]) > summary`).click(); }
    const item = drawer.getByRole("group", { name: `样本 ${index + 1}`, exact: true });
    await item.getByRole("combobox", { name: "业务评测角色", exact: true }).selectOption(source.role);
    await item.getByRole("textbox", { name: "样本稳定标识", exact: true }).fill(`business_${index + 1}`);
    await item.getByRole("textbox", { name: "题目名称", exact: true }).fill(`Synthetic ${source.role} ${source.complete ? "known" : "missing"}`);
    const options = item.getByRole("combobox", { name: "实际业务对象", exact: true });
    if (source.role === "procurement_review" && !source.complete) {
      // No balance is an intentional real gap. Its actual stock/location IDs are
      // accepted only after the same owning basis endpoint checks them.
      await item.getByRole("textbox", { name: "原业务对象 ID", exact: true }).fill(source.targetId);
    } else {
      await expect(options.locator(`option[value="${source.targetId}"]`)).toHaveCount(1);
      await options.selectOption(source.targetId);
    }
    await item.getByRole("textbox", { name: "固定分析重点", exact: true }).fill("Synthetic original fixed facts with missing values retained");
    const waiting = page.waitForResponse(response => new URL(response.url()).pathname === endpoint + "task-basis" && response.request().method() === "POST");
    await item.getByRole("button", { name: "读取并固定本题业务依据", exact: true }).click();
    const response = await waiting; expect(response.status()).toBe(200); const basis = AssistTaskBasisSchema.parse(await response.json());
    expect(basis.input.kind).toBe(source.role); expect(basis.input.expectedTaskFingerprint).toBe(basis.fingerprint); basisPins.push(basis.fingerprint);
    await expect(item.getByRole("region", { name: "已固定的真实业务任务", exact: true })).toContainText(basis.fingerprint);
    await item.getByRole("textbox", { name: "期望事实 每行一项", exact: true }).fill(source.role === "procurement_review" ? "calculations" : "reportingCurrency");
    await item.getByRole("textbox", { name: "禁止表述 每行一项", exact: true }).fill(forbidden);
    if (!source.complete) await item.getByRole("checkbox", { name: "要求缺少依据时拒答", exact: true }).check();
  }
  await drawer.getByRole("textbox", { name: "草稿保存依据", exact: true }).fill("Synthetic original owners and task pins reviewed; no guessed business identifiers or adopted actions");
  const saved = await posted(page, "datasets", () => drawer.getByRole("button", { name: "保存数据集草稿", exact: true }).click());
  const fields = BenchmarkDatasetFieldsSchema.parse(saved.input.fields); expect(fields.items).toHaveLength(4);
  fields.items.forEach((item, index) => { expect(item.role).toBe(sources[index]!.role);
    if (item.role === "knowledge_answer") throw new Error("Only the two admitted business roles belong in this dataset");
    expect(item.task.expectedTaskFingerprint).toBe(basisPins[index]); expect("editorKey" in item).toBe(false); });
  await drawer.getByRole("button", { name: "读取已保存数据集并关闭填写", exact: true }).click(); await expect(drawer).toHaveCount(0);
  const form = workspace(page).getByRole("form", { name: "发布固定数据集", exact: true });
  await form.getByRole("spinbutton", { name: "依据保留天数", exact: true }).fill("7");
  await form.getByRole("textbox", { name: "发布核对依据", exact: true }).fill("Synthetic whole four-item original manifest and exact business scope manually checked");
  const published = await posted(page, `datasets/${saved.receipt.id}/publish`, () => form.getByRole("button", { name: "核对并发布此数据集修订", exact: true }).click());
  await workspace(page).getByRole("button", { name: "读取实际发布版本", exact: true }).click();
  const response = await personalGet(page, "versions/" + published.receipt.id); expect(response.status()).toBe(200);
  const version = BenchmarkVersionSchema.parse(await response.json());
  expect(version.items).toHaveLength(4); expect(version.description).toBe(fields.description);
  expect(version.items.every(item => item.caseId === null && item.sourcePins.length > 0 && item.sourcePins.every(pin => "kind" in pin && pin.kind === "business"))).toBe(true);
  expect(owner.fixture.modelCalls()).toBe(0);
  await workspace(page).getByRole("button", { name: "按此固定版本准备实验", exact: true }).click();
  const create = workspace(page).getByRole("form", { name: "创建固定版本实验", exact: true });
  await create.getByRole("textbox", { name: "实验名称", exact: true }).fill(`SYNTHETIC-BUSINESS-EXPERIMENT-${randomUUID()}`);
  await create.getByRole("combobox", { name: "候选评测模型", exact: true }).selectOption(owner.fixture.modelId);
  await create.getByRole("spinbutton", { name: "每题候选尝试上限", exact: true }).fill("2");
  await create.getByRole("textbox", { name: "实验创建依据", exact: true }).fill("Synthetic fixed business packets and free business-facts-v1 baseline");
  await expect(create).toContainText(BUSINESS_BENCHMARK_RULE_VERSION);
  const created = await posted(page, "experiments", () => create.getByRole("button", { name: "创建实验并运行免费规则基线", exact: true }).click());
  expect(created.input.baselineVersion).toBe(BUSINESS_BENCHMARK_RULE_VERSION);
  await workspace(page).getByRole("button", { name: "读取实际实验和规则基线", exact: true }).click();
  await expect(experiment(page)).toContainText(created.receipt.id);
  return { version, experimentId: created.receipt.id, forbidden };
}
async function startInUi(page: Page, experimentId: string, key: string) {
  await experiment(page).getByRole("button", { name: "准备本题新的付费尝试 " + key, exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "核对本题新的付费尝试", exact: true });
  await drawer.getByRole("checkbox", { name: "我已核对原样本及最新尝试 明确开始这一次新的付费调用", exact: true }).check();
  const born = await posted(page, `experiments/${experimentId}/attempts/start`, () => drawer.getByRole("button", { name: "确认本题新的付费尝试", exact: true }).click());
  await drawer.getByRole("button", { name: "读取实际原尝试与结果", exact: true }).click(); await expect(drawer).toHaveCount(0); return born;
}
async function complete(page: Page, owner: Owner, attempt: BenchmarkAttempt, version: BenchmarkVersion) {
  const item = version.items.find(row => row.id === attempt.itemId);
  if (!item || !attempt.nativeRunId || attempt.evaluationRunId) throw new Error("Real business native run and fixed item required");
  await owner.fixture.analyze(attempt.nativeRunId, await owner.output(item));
  const done = await readAttempt(page, attempt.id);
  expect(done).toMatchObject({ state: "completed", assessment: { hardPass: true, graderVersion: "business-benchmark-checks-v1" },
    evaluationRunId: null, nativeRunId: attempt.nativeRunId, resultAvailable: true, modelCost: { amountUsd: "0.00021000", source: "usage_estimate" } });
  expect(done.result?.typedAnswers).toBeUndefined(); expect(done.result?.actions).toEqual([]); return done;
}

test("publishes both real business roles, restores one lost paid receipt and seals fixed-denominator costs without changing original business facts", async ({ page }, info) => {
  const owner = await businessBenchmarkBrowser("real-business-arms"), observed = observe(page);
  try {
    const sources = await owner.sources(), before = await owner.businessState();
    await loginErp(page, "operator", "/knowledge"); await ready(page);
    const scene = await publishInUi(page, owner, sources), response = await personalGet(page, "experiments/" + scene.experimentId);
    expect(response.status()).toBe(200); const initial = BenchmarkExperimentSchema.parse(await response.json());
    expect(initial.baselineVersion).toBe(BUSINESS_BENCHMARK_RULE_VERSION); expect(initial.cells).toHaveLength(4);
    for (const [index, cell] of initial.cells.entries()) {
      const baseline = await readAttempt(page, cell.baselineAttemptId);
      expect(baseline).toMatchObject({ arm: "baseline", state: "completed", nativeRunId: null, evaluationRunId: null,
        assessment: { hardPass: true }, modelCost: { amountUsd: "0.00000000", source: "not_submitted", confirmedProviderCalls: 0 } });
      expect(baseline.result?.typedAnswers).toBeUndefined();
      if (index % 2 === 1) expect(baseline.result?.missingInformation.length).toBeGreaterThan(0);
      if (index === 2) expect(baseline.result?.findings.filter(item => item.location === "current").map(item => item.detail).join("")).toContain('"profitMinor":5300');
    }
    expect(owner.fixture.modelCalls()).toBe(0);
    const path = endpoint + `experiments/${scene.experimentId}/attempts/start`, pattern = "**" + path;
    let captured: { receipt: ReturnType<typeof BenchmarkReceiptSchema.parse>; input: ReturnType<typeof StartBenchmarkAttemptSchema.parse> } | undefined;
    let started = false, returned = false, routeError: unknown;
    const lose = async (route: Route) => { try {
      started = true;
      const input = StartBenchmarkAttemptSchema.parse(route.request().postDataJSON()), actual = await route.fetch(); expect(actual.status()).toBe(201);
      captured = { input, receipt: BenchmarkReceiptSchema.parse(await actual.json()) }; await route.abort("failed");
    } catch (error) { routeError = error; } finally { returned = true; } };
    await page.route(pattern, lose);
    try {
      await experiment(page).getByRole("button", { name: "准备本题新的付费尝试 business_1", exact: true }).click();
      const drawer = page.getByRole("dialog", { name: "核对本题新的付费尝试", exact: true });
      await drawer.getByRole("checkbox", { name: "我已核对原样本及最新尝试 明确开始这一次新的付费调用", exact: true }).check();
      await drawer.getByRole("button", { name: "确认本题新的付费尝试", exact: true }).click();
      await expect.poll(() => returned, { timeout: 30_000 }).toBe(true); if (routeError) throw routeError;
      await expect(drawer.getByRole("button", { name: "按固定正文和原编号重试", exact: true })).toBeEnabled();
    } finally { if (started) await expect.poll(() => returned, { timeout: 30_000 }).toBe(true); await page.unroute(pattern, lose); }
    if (!captured) throw new Error("Actual committed business attempt receipt missing"); const original = captured;
    const marker = (await intents(page)).find(value => value.requestId === original.input.requestId);
    expect(marker).toMatchObject({ operation: "attempt.start", parentId: scene.experimentId, attemptInput: original.input });
    expect(JSON.stringify(marker)).not.toContain(scene.forbidden); expect(JSON.stringify(marker)).not.toContain("expectedFacts");
    page.once("dialog", dialog => void dialog.accept()); await page.reload(); await ready(page);
    const recovery = page.getByRole("article", { name: "原评测请求 " + original.input.requestId, exact: true });
    const receiptRead = page.waitForResponse(value => new URL(value.url()).pathname === endpoint + "requests/" + original.input.requestId && value.request().method() === "GET");
    await recovery.getByRole("button", { name: "只读取原命令回执", exact: true }).click();
    const recovered = await receiptRead; expect(recovered.status()).toBe(200);
    expect(BenchmarkCommandReceiptSchema.parse(await recovered.json()).receipt).toEqual(original.receipt);
    await recovery.getByRole("button", { name: "读取原登记结果", exact: true }).click();
    await expect(attemptRegion(page)).toContainText(original.receipt.id);
    await workspace(page).getByRole("button", { name: "读取此尝试所属原实验", exact: true }).click();
    await expect(experiment(page)).toContainText(scene.experimentId);
    await recovery.getByRole("button", { name: "确认原回执并清除恢复标识", exact: true }).click();
    expect(owner.fixture.modelCalls()).toBe(0);
    const first = await complete(page, owner, await readAttempt(page, original.receipt.id), scene.version);
    await openAttempt(page, first.id); await expect(attemptRegion(page)).toContainText("原硬检查通过"); await review(page, first.id);
    const next = await startInUi(page, scene.experimentId, "business_4"), second = await complete(page, owner, await readAttempt(page, next.receipt.id), scene.version);
    expect(second.result?.missingInformation.length).toBeGreaterThan(0);
    await openAttempt(page, second.id); await expect(attemptRegion(page)).toContainText(second.result!.missingInformation[0]!); await review(page, second.id);
    const costs = workspace(page).getByRole("region", { name: "实验成本与封存报告", exact: true });
    await costs.getByRole("button", { name: "登记候选累计存储维护", exact: true }).click();
    const expense = page.getByRole("dialog", { name: "登记累计存储维护成本", exact: true });
    await expense.getByRole("textbox", { name: "累计存储费用 USD", exact: true }).fill("0.01");
    await expense.getByRole("textbox", { name: "累计维护费用 USD", exact: true }).fill("0.25");
    await expense.getByRole("textbox", { name: "实际累计分摊依据", exact: true }).fill("Synthetic cumulative source storage, maintenance and two actually reviewed native attempts; unrun items remain unknown");
    await expense.getByRole("checkbox", { name: "我已按上述活动和期间核对累计存储维护值 未知项保持空白", exact: true }).check();
    await posted(page, `experiments/${scene.experimentId}/expenses`, () => expense.getByRole("button", { name: "登记原活动的累计成本", exact: true }).click());
    await expense.getByRole("button", { name: "确认成本登记回执并重读摘要", exact: true }).click(); await expect(expense).toHaveCount(0);
    const summaryResponse = await personalGet(page, `experiments/${scene.experimentId}/costs`); expect(summaryResponse.status()).toBe(200);
    const summary = BenchmarkCostSummarySchema.parse(await summaryResponse.json());
    expect(summary.candidate).toMatchObject({ totalItems: 4, qualifiedItems: 2, notRunItems: 2, allAttempts: 2,
      modelKnownUsd: "0.00042000", humanKnownUsd: "6.00000000", knownSubtotalUsd: "6.26042000", state: "incomplete", totalUsd: null, unitQualifiedCostUsd: null });
    await expect(costs.getByRole("region", { name: "候选全部尝试成本", exact: true })).toContainText("未知 未按零补齐");
    const seal = costs.getByRole("form", { name: "封存实验报告", exact: true });
    await seal.getByRole("textbox", { name: "报告封存依据", exact: true }).fill("Synthetic original four-item denominator; two candidate attempts, actual minutes, estimated model costs and unrun items remain incomplete");
    const sealed = await posted(page, `experiments/${scene.experimentId}/reports`, () => seal.getByRole("button", { name: "明确封存本次实验报告", exact: true }).click());
    await costs.getByRole("button", { name: "读取实际封存报告", exact: true }).click();
    const reportRegion = costs.getByRole("region", { name: "不可变实验报告", exact: true }); await expect(reportRegion).toContainText(sealed.receipt.id);
    const reportResponse = await personalGet(page, "reports/" + sealed.receipt.id); expect(reportResponse.status()).toBe(200);
    const report = BenchmarkReportSchema.parse(await reportResponse.json());
    expect(report).toMatchObject({ baselineVersion: BUSINESS_BENCHMARK_RULE_VERSION, graderVersion: "business-benchmark-checks-v1", datasetChecksum: scene.version.checksum });
    expect(report.attemptIds).toHaveLength(6); expect(report.assessmentIds).toHaveLength(6); expect(report.reviewIds).toHaveLength(2); expect(report.summary.candidate).toEqual(summary.candidate);
    const actor = actors().operator, [counts] = await owner.database.client.unsafe<{ candidates: number; natives: number; knowledgeRuns: number }[]>(`select
      (select count(*)::int from knowledge_benchmark_attempts where tenant_id=$1::uuid and experiment_id=$2::uuid and arm='candidate') as candidates,
      (select count(*)::int from ai_assist_runs r join knowledge_benchmark_attempts a on a.native_run_id=r.id where a.tenant_id=$1::uuid and a.experiment_id=$2::uuid) as natives,
      (select count(*)::int from knowledge_evaluation_runs r join knowledge_benchmark_attempts a on a.evaluation_run_id=r.id where a.tenant_id=$1::uuid and a.experiment_id=$2::uuid) as "knowledgeRuns"`, [actor.tenantId, scene.experimentId]);
    expect(counts).toEqual({ candidates: 2, natives: 2, knowledgeRuns: 0 }); expect(owner.fixture.modelCalls()).toBe(2);
    for (const body of owner.requests) { const text = JSON.stringify(body); expect(text).not.toContain("expectedFacts"); expect(text).not.toContain("forbiddenClaims"); expect(text).not.toContain(scene.forbidden); expect(text).not.toContain("benchmarkCalculations"); }
    expect(observed.posts.filter(value => value.path.endsWith("/attempts/start"))).toHaveLength(2);
    expect(await owner.businessState()).toEqual(before); expect(observed.pageErrors).toEqual([]);
    expect(observed.consoleErrors).toEqual([{ text: "Failed to load resource: net::ERR_FAILED", path }]);
    owner.proof.actualCounts = counts; owner.proof.businessFactsUnchanged = true; owner.proof.reportId = report.id;
    owner.proof.reportChecksum = createHash("sha256").update(JSON.stringify(report)).digest("hex");
    await screenshot(page, info, "business-original-report-desktop", 1440, reportRegion.getByRole("heading", { name: /^原封存报告/ }));
    await screenshot(page, info, "business-original-report-mobile", 390, reportRegion.getByRole("region", { name: "候选全部尝试成本", exact: true }));
  } finally { await owner.close(); }
});

test("clears delayed original business evidence after domain scope narrowing while keeping Workflow access and rejects a fresh BFF entry", async ({ page }, info) => {
  const owner = await businessBenchmarkBrowser("domain-authority"), observed = observe(page);
  try {
    await owner.domainScope("tenant"); const sources = await owner.sources();
    await loginErp(page, "operator", "/knowledge"); await ready(page);
    const fields = BenchmarkDatasetFieldsSchema.parse({ name: `SYNTHETIC-PRIVATE-BUSINESS-${randomUUID()}`, description: "Synthetic current domain authority fixture",
      items: await Promise.all([sources[0]!, sources[2]!].map(async (source, index) => {
        const response = await personalPost(page, "task-basis", { kind: source.role, targetId: source.targetId, taskGoal: "Synthetic current source authority" }, 200);
        return BusinessBenchmarkCaseSchema.parse({ key: `domain_${index + 1}`, role: source.role, label: `Synthetic private ${source.role}`,
          task: AssistTaskBasisSchema.parse(await response.json()).input, expectedFacts: [], forbiddenClaims: [], expectRefusal: false });
      })) });
    const saved = BenchmarkReceiptSchema.parse(await (await personalPost(page, "datasets", { fields, expectedRevision: 0, reason: "Synthetic fixed domain authority", requestId: randomUUID() })).json());
    const published = BenchmarkReceiptSchema.parse(await (await personalPost(page, `datasets/${saved.id}/publish`, { expectedRevision: 1, retentionDays: 7,
      reason: "Synthetic exact two-role original scope reviewed", requestId: randomUUID() })).json());
    const created = BenchmarkReceiptSchema.parse(await (await personalPost(page, "experiments", { datasetVersionId: published.id,
      baselineVersion: BUSINESS_BENCHMARK_RULE_VERSION, modelId: owner.fixture.modelId, label: `SYNTHETIC-DOMAIN-EXPERIMENT-${randomUUID()}`,
      maxAttemptsPerItem: 1, reason: "Synthetic original read-only results for current authority", requestId: randomUUID() })).json());
    await workspace(page).getByRole("button", { name: "实验 尝试与成本报告", exact: true }).click();
    const select = workspace(page).getByRole("form", { name: "按原实验 ID 读取", exact: true });
    await select.getByRole("textbox", { name: "原实验 ID", exact: true }).fill(created.id); await select.getByRole("button", { name: "读取原实验", exact: true }).click();
    await expect(experiment(page)).toContainText(created.id);
    const response = await personalGet(page, "experiments/" + created.id); expect(response.status()).toBe(200); const current = BenchmarkExperimentSchema.parse(await response.json());
    const firstId = current.cells[0]!.baselineAttemptId, secondId = current.cells[1]!.baselineAttemptId;
    await openAttempt(page, firstId); await expect(attemptRegion(page).getByRole("region", { name: "本次受权读取原答案", exact: true })).toContainText("calculations");
    await openAttempt(page, secondId);
    const path = endpoint + "attempts/" + firstId, pattern = "**" + path;
    let release: (() => void) | undefined, started = false, fetched = false, returned = false, routeError: unknown;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const delayed = async (route: Route) => { try { started = true; const actual = await route.fetch(); expect(actual.status()).toBe(200);
      const original = BenchmarkAttemptSchema.parse(await actual.json()); expect(original.id).toBe(firstId); expect(original.resultAvailable).toBe(true);
      fetched = true; await gate; await route.fulfill({ response: actual });
    } catch (error) { routeError = error; } finally { returned = true; } };
    await page.route(pattern, delayed);
    try {
      const form = workspace(page).getByRole("form", { name: "按原尝试 ID 读取", exact: true });
      await form.getByRole("textbox", { name: "原尝试 ID", exact: true }).fill(firstId); await form.getByRole("button", { name: "读取原实验尝试", exact: true }).click();
      await expect.poll(() => fetched, { timeout: 15_000 }).toBe(true);
      await owner.domainScope("self"); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(attemptRegion(page)).toHaveCount(0); await expect(experiment(page)).toHaveCount(0);
      const session = await page.request.get("/api/erp-auth/session"); expect(session.status()).toBe(200); const narrowed = ErpSessionViewSchema.parse(await session.json());
      expect(narrowed.permissions).toContain(Permission.WorkflowRead); expect(narrowed.permissionScopes?.[Permission.WorkflowRead] ?? narrowed.dataScope).toBe("tenant");
      for (const bit of [Permission.ProcurementRead, Permission.InventoryRead, Permission.FinanceRead, Permission.OrderRead]) {
        expect(narrowed.permissions).toContain(bit); expect(narrowed.permissionScopes?.[bit]).toBe("self");
      }
      if (!release) throw new Error("Synthetic delayed business result gate missing"); release();
      await expect.poll(() => returned, { timeout: 15_000 }).toBe(true);
      if (routeError && !observed.failed.some(value => value.path === path && value.error === "net::ERR_ABORTED")) throw routeError;
      await expect(page.getByText(created.id, { exact: false })).toHaveCount(0); await expect(page.getByText("calculations", { exact: false })).toHaveCount(0);
      // Re-enter with Workflow still tenant-authorized. A real new BFF request
      // must refuse the old domain packet; parent unmounting alone is insufficient.
      const deniedRead = page.waitForResponse(value => new URL(value.url()).pathname === endpoint + "datasets" && value.request().method() === "GET" &&
        value.request().headers()["x-yummyai-context-authority"] === erpSessionAuthority(narrowed), { timeout: 15_000 });
      await ready(page); const denied = await deniedRead; expect(denied.status()).toBe(403);
      await expect(workspace(page)).toContainText("当前本人或知识评测读取范围已变化");
      for (const originalPath of ["versions/" + published.id, "attempts/" + firstId, "task-targets?kind=business_review", "task-targets?kind=procurement_review"]) {
        const forbidden = await personalGet(page, originalPath); expect(forbidden.status()).toBe(403); expect(await forbidden.text()).not.toContain(fields.name);
      }
      const forbiddenBasis = await personalPost(page, "task-basis", { kind: "business_review", targetId: sources[2]!.targetId, taskGoal: "Synthetic denied old source" }, 403);
      expect(await forbiddenBasis.text()).not.toContain(sources[2]!.targetId);
      await expect(attemptRegion(page)).toHaveCount(0); await expect(experiment(page)).toHaveCount(0);
      expect((await intents(page)).length).toBe(0); expect(owner.fixture.modelCalls()).toBe(0); expect(observed.pageErrors).toEqual([]);
      expect(observed.consoleErrors.every(value => value.path === endpoint + "datasets" && value.text === "Failed to load resource: the server responded with a status of 403 (Forbidden)" &&
        observed.responses.some(response => response.path === value.path && response.status === 403))).toBe(true);
      expect(observed.consoleErrors.length).toBeLessThanOrEqual(observed.responses.filter(response => response.path === endpoint + "datasets" && response.status === 403).length);
      owner.proof.workflowReadRetained = "tenant"; owner.proof.domainScopesNarrowed = "self"; owner.proof.freshBffStatus = denied.status();
      await screenshot(page, info, "business-domain-revoked-mobile", 390, workspace(page));
    } finally { release?.(); if (started) await expect.poll(() => returned, { timeout: 15_000 }).toBe(true); await page.unroute(pattern, delayed); }
  } finally { await owner.close(); }
});
