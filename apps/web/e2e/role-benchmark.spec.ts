import { expect, test, type Locator, type Page, type Route, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Permission } from "@yummyai/authz/permissions";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AssistTaskBasisSchema } from "@yummyai/contracts/ai/task-workspace";
import { BenchmarkAttemptSchema, BenchmarkCommandReceiptSchema, BenchmarkDatasetFieldsSchema, BenchmarkExperimentSchema,
  BenchmarkReceiptSchema, BenchmarkReportSchema, BenchmarkVersionSchema, ROLE_BENCHMARK_GRADER_VERSION, ROLE_BENCHMARK_RULE_VERSION,
  StartBenchmarkAttemptSchema, type BenchmarkAttempt } from "@yummyai/contracts/knowledge/benchmark";
import { loginErp } from "./erp-identity-fixture";
import { closeRoleBenchmarkBrowsers, requireRoleBenchmarkBrowser, roleBenchmarkBrowser, type RoleBenchmarkSource } from "./role-benchmark-fixture";

requireRoleBenchmarkBrowser();
test.afterAll(closeRoleBenchmarkBrowsers);
const endpoint = "/api/knowledge-governance/benchmarks/", intentPrefix = "yummyai.knowledge-benchmark.intent.v1:";
const workspace = (page: Page) => page.getByRole("region", { name: "固定数据集与实验", exact: true });
const experiment = (page: Page) => page.getByRole("region", { name: "固定分母实验详情", exact: true });
const attemptRegion = (page: Page) => page.getByRole("region", { name: "原实验尝试结果", exact: true });
type Owner = Awaited<ReturnType<typeof roleBenchmarkBrowser>>;
function preserveTestErrors(primary: unknown[], cleanup: unknown[]) {
  if (cleanup.length) throw new AggregateError([...primary, ...cleanup], "role_benchmark_primary_and_cleanup_failed");
  if (primary.length) throw primary[0];
}
async function ready(page: Page) {
  await expect(page.getByRole("heading", { name: "运营知识库", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "治理中心", exact: true }).click();
  await page.getByRole("button", { name: "固定数据集与实验", exact: true }).click();
  await expect(workspace(page)).toBeVisible();
}
async function headers(page: Page) { const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200); return { "x-yummyai-context-authority": erpSessionAuthority(ErpSessionViewSchema.parse(await response.json())) }; }
async function personalGet(page: Page, path: string) { return page.request.get(endpoint + path, { headers: await headers(page) }); }
async function readAttempt(page: Page, id: string) { const response = await personalGet(page, "attempts/" + id); expect(response.status()).toBe(200); return BenchmarkAttemptSchema.parse(await response.json()); }
async function posted(page: Page, path: string, action: () => Promise<void>) {
  const waiting = page.waitForResponse(response => new URL(response.url()).pathname === endpoint + path && response.request().method() === "POST");
  const [response] = await Promise.all([waiting, action()]); expect(response.status()).toBe(201);
  return { receipt: BenchmarkReceiptSchema.parse(await response.json()), input: response.request().postDataJSON() as Record<string, unknown> };
}
function observe(page: Page) {
  const posts: string[] = [], pageErrors: string[] = [], consoleErrors: Array<{ text: string; path: string }> = [], failed: Array<{ path: string; error: string }> = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (request.method() === "POST" && path.startsWith(endpoint)) posts.push(path); });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") { let path = ""; try { path = new URL(message.location().url).pathname; } catch { /* Unknown locations are not allowed. */ } consoleErrors.push({ text: message.text(), path }); } });
  page.on("requestfailed", request => failed.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText ?? "" }));
  return { posts, pageErrors, consoleErrors, failed };
}
async function screenshot(page: Page, info: TestInfo, target: Locator, label: string, width: 1440 | 390) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 }); await target.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const region of await workspace(page).locator(".kb-benchmark-pairs, .kb-benchmark-role-result, .kb-benchmark-role-input").all())
    if (await region.isVisible()) expect(await region.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath(label + ".png"), fullPage: false });
}
async function fillSource(page: Page, item: Locator, source: RoleBenchmarkSource) {
  await item.getByRole("combobox", { name: "业务评测角色", exact: true }).selectOption(source.role);
  const selection = item.getByRole("combobox", { name: "实际业务对象", exact: true });
  await expect(selection.locator(`option[value="${source.targetId}"]`)).toHaveCount(1); await selection.selectOption(source.targetId);
  await expect(item.getByRole("textbox", { name: "原业务对象 ID", exact: true })).toHaveJSProperty("readOnly", true);
  await item.getByRole("textbox", { name: "固定分析重点", exact: true }).fill("仅核对已脱敏原事实与缺项 不审批 采用或推测图片质量");
  const waiting = page.waitForResponse(response => new URL(response.url()).pathname === endpoint + "task-basis" && response.request().method() === "POST");
  await item.getByRole("button", { name: "读取并固定本题业务依据", exact: true }).click();
  const response = await waiting; expect(response.status()).toBe(200); const basis = AssistTaskBasisSchema.parse(await response.json());
  expect(basis.input.kind).toBe(source.role); expect(basis.input.expectedTaskFingerprint).toBe(basis.fingerprint);
  if (basis.input.kind === "artwork_preflight") { expect(basis.input).not.toHaveProperty("automaticAudit"); expect(basis.input).not.toHaveProperty("retryAudit"); }
  if (basis.input.kind === "after_sales_review") expect(basis.input.locale).toBe("en-US");
  await expect(item.getByRole("region", { name: "已固定的真实业务任务", exact: true })).toContainText(basis.fingerprint);
  return basis;
}
async function createInUi(page: Page, owner: Owner, sources: RoleBenchmarkSource[]) {
  await workspace(page).getByRole("button", { name: "新建数据集草稿", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "新建固定数据集草稿", exact: true }), forbidden = `SYNTHETIC_GOLD_ONLY_${randomUUID()}`;
  await drawer.getByRole("combobox", { name: "固定样本类型", exact: true }).selectOption("business");
  await drawer.getByRole("textbox", { name: "数据集名称", exact: true }).fill(`SYNTHETIC-SIX-ROLES-${randomUUID()}`);
  await drawer.getByRole("textbox", { name: "数据集说明", exact: true }).fill("Known synthetic object IDs, anonymized task descriptions and controlled renderer sources only; no production acceptance claim");
  await expect(drawer).toContainText("固定题目与预期长期保留");
  const pins: string[] = [];
  for (const [index, source] of sources.entries()) {
    if (index) { await drawer.getByRole("button", { name: "添加固定样本", exact: true }).click(); await drawer.locator(`details:has(> [role="group"][aria-label="样本 ${index + 1}"]) > summary`).click(); }
    const item = drawer.getByRole("group", { name: `样本 ${index + 1}`, exact: true });
    await item.getByRole("textbox", { name: "样本稳定标识", exact: true }).fill(source.role);
    await item.getByRole("textbox", { name: "题目名称", exact: true }).fill(`Synthetic original ${source.role}`);
    pins.push((await fillSource(page, item, source)).fingerprint);
    await item.getByRole("textbox", { name: "禁止表述 每行一项", exact: true }).fill(forbidden);
    if (!source.complete) await item.getByRole("checkbox", { name: "要求缺少依据时拒答", exact: true }).check();
  }
  await drawer.getByRole("textbox", { name: "草稿保存依据", exact: true }).fill("Actual original owner basis and anonymized fixed task text reviewed; no business output adopted");
  const saved = await posted(page, "datasets", () => drawer.getByRole("button", { name: "保存数据集草稿", exact: true }).click());
  const fields = BenchmarkDatasetFieldsSchema.parse(saved.input.fields); expect(fields.items).toHaveLength(sources.length);
  fields.items.forEach((item, index) => { expect(item.role).toBe(sources[index]!.role); if (item.role === "knowledge_answer") throw new Error("Native role dataset cannot become a knowledge question"); expect(item.task.expectedTaskFingerprint).toBe(pins[index]); });
  await drawer.getByRole("button", { name: "读取已保存数据集并关闭填写", exact: true }).click(); await expect(drawer).toHaveCount(0);
  const publish = workspace(page).getByRole("form", { name: "发布固定数据集", exact: true });
  await publish.getByRole("textbox", { name: "发布核对依据", exact: true }).fill("Six actual source packets, immutable versions and de-identified prompts manually checked");
  const published = await posted(page, `datasets/${saved.receipt.id}/publish`, () => publish.getByRole("button", { name: "核对并发布此数据集修订", exact: true }).click());
  await workspace(page).getByRole("button", { name: "读取实际发布版本", exact: true }).click();
  const response = await personalGet(page, "versions/" + published.receipt.id); expect(response.status()).toBe(200); const version = BenchmarkVersionSchema.parse(await response.json());
  expect(version.items).toHaveLength(sources.length); expect(version.items.every(item => item.caseId === null && item.sourcePins.length > 0 && "kind" in item.sourcePins[0]! && Boolean(item.sourcePins[0].resourceBindings))).toBe(true);
  expect(owner.fixture.modelCalls()).toBe(0); await workspace(page).getByRole("button", { name: "按此固定版本准备实验", exact: true }).click();
  const form = workspace(page).getByRole("form", { name: "创建固定版本实验", exact: true });
  await form.getByRole("textbox", { name: "实验名称", exact: true }).fill(`SYNTHETIC-ROLE-EXPERIMENT-${randomUUID()}`);
  await form.getByRole("combobox", { name: "候选评测模型", exact: true }).selectOption(owner.fixture.modelId);
  await form.getByRole("textbox", { name: "实验创建依据", exact: true }).fill("Original role-facts baseline extracts facts; image and creative quality remain human review questions");
  await expect(form).toContainText(ROLE_BENCHMARK_RULE_VERSION);
  const born = await posted(page, "experiments", () => form.getByRole("button", { name: "创建实验并运行免费规则基线", exact: true }).click());
  expect(born.input.baselineVersion).toBe(ROLE_BENCHMARK_RULE_VERSION);
  await workspace(page).getByRole("button", { name: "读取实际实验和规则基线", exact: true }).click(); await expect(experiment(page)).toContainText(born.receipt.id);
  return { version, experimentId: born.receipt.id, forbidden };
}
async function openAttempt(page: Page, id: string) {
  const form = workspace(page).getByRole("form", { name: "按原尝试 ID 读取", exact: true });
  await form.getByRole("textbox", { name: "原尝试 ID", exact: true }).fill(id);
  if (await experiment(page).count()) await experiment(page).getByRole("button", { name: "重新读取实验与成本", exact: true }).click();
  await form.getByRole("button", { name: "读取原实验尝试", exact: true }).click(); await expect(attemptRegion(page)).toContainText(id);
}
async function start(page: Page, experimentId: string, key: string) {
  await experiment(page).getByRole("button", { name: "准备本题新的付费尝试 " + key, exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "核对本题新的付费尝试", exact: true });
  await drawer.getByRole("checkbox", { name: "我已核对原样本及最新尝试 明确开始这一次新的付费调用", exact: true }).check();
  const born = await posted(page, `experiments/${experimentId}/attempts/start`, () => drawer.getByRole("button", { name: "确认本题新的付费尝试", exact: true }).click());
  await drawer.getByRole("button", { name: "读取实际原尝试与结果", exact: true }).click(); await expect(drawer).toHaveCount(0); return born.receipt.id;
}
async function assertOriginalOutput(page: Page, done: BenchmarkAttempt) {
  if (!done.result) throw new Error("Actual native output required");
  const view = attemptRegion(page).getByRole("region", { name: "原业务建议与文本核验边界", exact: true });
  for (const direction of done.result.directions) { const detail = view.getByRole("region", { name: "原创意方向", exact: true }).locator("details").filter({ has: page.locator("summary", { hasText: direction.title }) }); await detail.locator(":scope > summary").click(); await expect(detail).toContainText(direction.prompt); await expect(detail).toContainText(direction.negativePrompt); }
  for (const match of done.result.matches) { const section = view.getByRole("region", { name: "原匹配建议", exact: true }); await expect(section).toContainText(match.artworkVersionId); await expect(section).toContainText(match.specificationVersionId); }
  for (const slot of done.result.templateSlots) { const section = view.getByRole("region", { name: "原模板图层建议", exact: true }), detail = section.locator("details").filter({ has: page.locator("summary", { hasText: slot.stableKey }) }); await detail.locator(":scope > summary").click(); await expect(detail).toContainText(slot.reason); }
  if (done.result.listingCopy) { const section = view.getByRole("region", { name: "原 Listing 文案", exact: true }); await expect(section).toContainText(done.result.listingCopy.title); await expect(section).toContainText(done.result.listingCopy.description); for (const image of done.result.listingCopy.imageDescriptions) await expect(section).toContainText(image.assetId); }
  if (done.result.replyDraft) { const section = view.getByRole("region", { name: "原售后回复草稿", exact: true }); await expect(section).toContainText(done.result.replyDraft.locale); await expect(section).toContainText(done.result.replyDraft.body); }
  expect(await view.locator("button,input,textarea,select").count()).toBe(0);
}

test("fixes six real native role sources, restores one original paid receipt and reads complete role outputs without adopting business facts", async ({ page }, info) => {
  test.setTimeout(300_000);
  const owner = await roleBenchmarkBrowser("six-real-roles"), observed = observe(page); let primary: unknown[] = [];
  try {
    const sources: RoleBenchmarkSource[] = [];
    for (const role of ["order_review", "artwork_preflight", "after_sales_review", "creative", "template_config", "sku_package"] as const) sources.push(await owner.source(role, role !== "creative"));
    const before = await owner.state(); await loginErp(page, "operator", "/knowledge"); await ready(page);
    const scene = await createInUi(page, owner, sources); owner.proof.versionId = scene.version.id; owner.proof.experimentId = scene.experimentId;
    const initialResponse = await personalGet(page, "experiments/" + scene.experimentId); expect(initialResponse.status()).toBe(200); const initial = BenchmarkExperimentSchema.parse(await initialResponse.json());
    const creative = scene.version.items.find(item => item.fields.role === "creative")!, creativeCell = initial.cells.find(cell => cell.itemId === creative.id)!;
    const baseline = await readAttempt(page, creativeCell.baselineAttemptId); expect(baseline).toMatchObject({ arm: "baseline", state: "completed", nativeRunId: null, assessment: { hardPass: false, graderVersion: ROLE_BENCHMARK_GRADER_VERSION } }); expect(baseline.result?.directions).toEqual([]);
    await openAttempt(page, baseline.id); await expect(attemptRegion(page)).toContainText("原硬失败 不可由人工通过覆盖");
    const firstKey = sources[0]!.role, path = endpoint + `experiments/${scene.experimentId}/attempts/start`, pattern = "**" + path;
    let captured: { id: string; input: ReturnType<typeof StartBenchmarkAttemptSchema.parse> } | undefined, returned = false, routeError: unknown;
    const lose = async (route: Route) => { try { const input = StartBenchmarkAttemptSchema.parse(route.request().postDataJSON()), response = await route.fetch(); expect(response.status()).toBe(201); captured = { id: BenchmarkReceiptSchema.parse(await response.json()).id, input }; await route.abort("failed"); } catch (error) { routeError = error; } finally { returned = true; } };
    await page.route(pattern, lose);
    try { await experiment(page).getByRole("button", { name: "准备本题新的付费尝试 " + firstKey, exact: true }).click(); const drawer = page.getByRole("dialog", { name: "核对本题新的付费尝试", exact: true });
      await drawer.getByRole("checkbox", { name: "我已核对原样本及最新尝试 明确开始这一次新的付费调用", exact: true }).check(); await drawer.getByRole("button", { name: "确认本题新的付费尝试", exact: true }).click();
      await expect.poll(() => returned, { timeout: 30_000 }).toBe(true); if (routeError) throw routeError; await expect(drawer.getByRole("button", { name: "按固定正文和原编号重试", exact: true })).toBeEnabled();
    } finally { await page.unroute(pattern, lose); }
    if (!captured) throw new Error("Actual native candidate receipt was not captured"); const original = captured;
    const markers = await page.evaluate(prefix => Object.keys(sessionStorage).filter(key => key.startsWith(prefix)).map(key => JSON.parse(sessionStorage.getItem(key)!)), intentPrefix);
    expect(markers).toContainEqual(expect.objectContaining({ requestId: original.input.requestId, attemptInput: original.input, parentId: scene.experimentId }));
    expect(JSON.stringify(markers)).not.toContain(scene.forbidden); expect(JSON.stringify(markers)).not.toContain("expectedFacts");
    page.once("dialog", dialog => void dialog.accept()); await page.reload(); await ready(page);
    const recovery = page.getByRole("article", { name: "原评测请求 " + original.input.requestId, exact: true }), read = page.waitForResponse(response => new URL(response.url()).pathname === endpoint + "requests/" + original.input.requestId && response.request().method() === "GET");
    await recovery.getByRole("button", { name: "只读取原命令回执", exact: true }).click(); const restored = await read; expect(restored.status()).toBe(200); expect(BenchmarkCommandReceiptSchema.parse(await restored.json()).receipt.id).toBe(original.id);
    await recovery.getByRole("button", { name: "读取原登记结果", exact: true }).click(); await expect(attemptRegion(page)).toContainText(original.id);
    await workspace(page).getByRole("button", { name: "读取此尝试所属原实验", exact: true }).click(); await expect(experiment(page)).toContainText(scene.experimentId);
    await recovery.getByRole("button", { name: "确认原回执并清除恢复标识", exact: true }).click(); expect(owner.fixture.modelCalls()).toBe(0);
    for (const [index, source] of sources.entries()) {
      const id = index === 0 ? original.id : await start(page, scene.experimentId, source.role), born = await readAttempt(page, id), item = scene.version.items.find(value => value.id === born.itemId);
      if (!born.nativeRunId || born.evaluationRunId || !item || item.fields.role !== source.role) throw new Error("Actual original native role attempt binding missing");
      await owner.fixture.analyze(born.nativeRunId, await owner.output(item.id, scene.version.id));
      const done = await readAttempt(page, id); expect(done).toMatchObject({ state: "completed", nativeRunId: born.nativeRunId, evaluationRunId: null, resultAvailable: true, assessment: { graderVersion: ROLE_BENCHMARK_GRADER_VERSION } });
      expect(done.result?.typedAnswers).toBeUndefined(); await openAttempt(page, id); await expect(attemptRegion(page)).toContainText(done.result!.summary); await assertOriginalOutput(page, done);
      if (source.role === "creative") expect(done.result?.directions).toHaveLength(3);
      if (source.role === "order_review") expect(done.result?.matches.length).toBeGreaterThan(0);
      if (source.role === "template_config") expect(done.result?.templateSlots.length).toBeGreaterThan(0);
      if (source.role === "sku_package") expect(done.result?.listingCopy).not.toBeNull();
      if (source.role === "after_sales_review") {
        expect(done.result?.replyDraft?.locale).toBe("en-US");
        await screenshot(page, info, attemptRegion(page).getByRole("region", { name: "原售后回复草稿", exact: true }), "six-role-original-desktop", 1440);
      }
      if (source.role === "artwork_preflight") expect(done.result?.artworkChecks).toEqual([]);
    }
    expect(owner.fixture.modelCalls()).toBe(6); expect(observed.posts.filter(value => value === path)).toHaveLength(6); expect(JSON.stringify(owner.requests)).not.toContain(scene.forbidden);
    const form = workspace(page).getByRole("form", { name: "封存实验报告", exact: true }); await form.getByRole("textbox", { name: "报告封存依据", exact: true }).fill("Six real native attempts, original creative rule hard failure and unknown human/storage/maintenance costs are preserved; no production release");
    const sealed = await posted(page, `experiments/${scene.experimentId}/reports`, () => form.getByRole("button", { name: "明确封存本次实验报告", exact: true }).click());
    await workspace(page).getByRole("button", { name: "读取实际封存报告", exact: true }).click(); const reportResponse = await personalGet(page, "reports/" + sealed.receipt.id); expect(reportResponse.status()).toBe(200); const report = BenchmarkReportSchema.parse(await reportResponse.json());
    expect(report).toMatchObject({ baselineVersion: ROLE_BENCHMARK_RULE_VERSION, graderVersion: ROLE_BENCHMARK_GRADER_VERSION, summary: { candidate: { totalItems: 6, allAttempts: 6, totalUsd: null, unitQualifiedCostUsd: null } } });
    await expect(workspace(page).getByRole("region", { name: "不可变实验报告", exact: true })).toContainText("未知 未按零补齐");
    await screenshot(page, info, workspace(page).getByRole("region", { name: "不可变实验报告", exact: true }), "six-role-original-mobile", 390);
    expect(await owner.state()).toEqual(before); owner.proof.originalBusinessFactsUnchanged = true; owner.proof.providerCalls = owner.fixture.modelCalls(); owner.proof.reportId = report.id;
    expect(observed.pageErrors).toEqual([]); expect(observed.failed.filter(value => value.path === path && value.error === "net::ERR_FAILED")).toHaveLength(1);
    expect(observed.consoleErrors.filter(value => !(value.path === path && value.text === "Failed to load resource: net::ERR_FAILED"))).toEqual([]);
  } catch (error) { primary = [error]; }
  const cleanup: unknown[] = [];
  try { await owner.close(); } catch (error) { cleanup.push(error); }
  preserveTestErrors(primary, cleanup);
});

test("rejects a delayed real role basis after current domain read is revoked while workflow read remains", async ({ page }, info) => {
  const owner = await roleBenchmarkBrowser("current-role-revocation"), observed = observe(page); let primary: unknown[] = [];
  let release: (() => Promise<void>) | undefined, routeStarted = false, released = false, routeError: unknown;
  const pattern = "**" + endpoint + "task-basis";
  const hold = async (route: Route) => { routeStarted = true; try { const response = await route.fetch(); expect(response.status()).toBe(200); const body = await response.body();
    await new Promise<void>((resolve, reject) => { release = async () => { try { await route.fulfill({ response, body }); released = true; resolve(); } catch (error) { reject(error); throw error; } }; });
  } catch (error) { routeError = error; } };
  try {
    const source = await owner.source("template_config", true), before = await owner.state(); await loginErp(page, "operator", "/knowledge"); await ready(page);
    await workspace(page).getByRole("button", { name: "新建数据集草稿", exact: true }).click(); const drawer = page.getByRole("dialog", { name: "新建固定数据集草稿", exact: true });
    await drawer.getByRole("combobox", { name: "固定样本类型", exact: true }).selectOption("business"); const item = drawer.getByRole("group", { name: "样本 1", exact: true });
    const oldBasis = await fillSource(page, item, source);
    await expect(item.getByRole("region", { name: "本题实际业务依据", exact: true })).toBeVisible();
    await expect(item.getByRole("region", { name: "已固定的真实业务任务", exact: true })).toContainText(oldBasis.fingerprint);
    await page.route(pattern, hold); await item.getByRole("textbox", { name: "固定分析重点", exact: true }).fill("Another de-identified focus to check current role authority");
    await item.getByRole("button", { name: "读取并固定本题业务依据", exact: true }).click(); await expect.poll(() => Boolean(release), { timeout: 30_000 }).toBe(true); if (routeError) throw routeError;
    await owner.fixture.setPermissions(Object.values(Permission).filter(bit => bit !== Permission.DesignRead));
    const [sessionResponse, refreshedLibrary] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === "/api/erp-auth/session" && response.request().method() === "GET"),
      page.waitForResponse(response => new URL(response.url()).pathname === "/api/knowledge/workspace" && response.request().method() === "GET"),
      page.evaluate(() => window.dispatchEvent(new Event("focus"))),
    ]);
    expect(sessionResponse.status()).toBe(200);
    const session = ErpSessionViewSchema.parse(await sessionResponse.json()); expect(session.permissions).toContain(Permission.WorkflowRead); expect(session.permissions).not.toContain(Permission.DesignRead);
    // The identity boundary replaces the document after the authority changes.
    // Assert its stable current library, not a transient message in the removed subtree.
    expect(refreshedLibrary.status()).toBe(200);
    const currentHeading = page.getByRole("heading", { name: "运营知识库", exact: true });
    const currentLibrary = page.getByRole("navigation", { name: "知识库视图", exact: true }).getByRole("button", { name: "知识管理", exact: true });
    await expect(currentHeading).toBeVisible(); await expect(currentLibrary).toHaveAttribute("aria-current", "page");
    await expect(workspace(page)).toHaveCount(0); await expect(drawer).toHaveCount(0);
    await expect(page.getByRole("region", { name: "本题实际业务依据", exact: true })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(source.targetId); await expect(page.locator("body")).not.toContainText(oldBasis.fingerprint);
    if (!release) throw new Error("Delayed actual role basis gate missing"); await release(); await expect.poll(() => released).toBe(true); if (routeError) throw routeError;
    await expect(currentLibrary).toHaveAttribute("aria-current", "page"); await expect(workspace(page)).toHaveCount(0); await expect(drawer).toHaveCount(0);
    await expect(page.getByRole("region", { name: "本题实际业务依据", exact: true })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(source.targetId); await expect(page.locator("body")).not.toContainText(oldBasis.fingerprint);
    const denied = await page.request.get(endpoint + "task-targets?kind=template_config", { headers: { "x-yummyai-context-authority": erpSessionAuthority(session) } }); expect(denied.status()).toBe(403);
    const noBasis = await page.request.post(endpoint + "task-basis", { headers: { origin: new URL(page.url()).origin, "x-yummyai-context-authority": erpSessionAuthority(session) }, data: { kind: "template_config", targetId: source.targetId, taskGoal: "No model call" } }); expect(noBasis.status()).toBe(403);
    expect(await denied.text()).not.toContain(source.targetId); expect(await noBasis.text()).not.toContain(source.targetId);
    await screenshot(page, info, currentHeading, "six-role-revoked-mobile", 390); expect(owner.fixture.modelCalls()).toBe(0); expect(await owner.state()).toEqual(before);
    expect(observed.pageErrors).toEqual([]); expect(observed.consoleErrors).toEqual([]); owner.proof.delayedPrivateBasisRejected = true; owner.proof.workflowReadRetained = true;
  } catch (error) { primary = [error]; }
  const cleanup: unknown[] = [];
  try { if (routeStarted && release && !released && !page.isClosed()) await release(); } catch (error) { cleanup.push(error); }
  try { if (!page.isClosed()) await page.unroute(pattern, hold); } catch (error) { cleanup.push(error); }
  try { await owner.close(); } catch (error) { cleanup.push(error); }
  preserveTestErrors(primary, cleanup);
});
