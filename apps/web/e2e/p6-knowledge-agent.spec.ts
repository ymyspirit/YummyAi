import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Permission } from "@yummyai/authz";
import { AgentNativeV4ItemReceiptSchema } from "@yummyai/contracts/ai/agent-native-v4";
import { AgentCommandViewSchema } from "@yummyai/contracts/ai/agent-command";
import { AssistViewSchema } from "@yummyai/contracts/ai/assist";
import type { KnowledgeWorkspace } from "@yummyai/contracts/knowledge";
import { centerApi } from "./order-centers-fixture";
import { loginErp } from "./erp-identity-fixture";
import { p6KnowledgeAgentFixture } from "./p6-knowledge-agent-browser-fixture";

test.describe.configure({ mode: "serial" });
type Fixture = Awaited<ReturnType<typeof p6KnowledgeAgentFixture>>;
const answer = "先核对资料并保留复核记录。";
const detail = (page: Page) => page.getByRole("region", { name: "知识详情", exact: true });

async function publish(page: Page, version: number) {
  await page.getByRole("button", { name: "提交审核", exact: true }).click();
  await page.getByLabel("操作说明", { exact: true }).fill("Synthetic P6 operator reviewed this knowledge source");
  await page.getByRole("button", { name: "确认提交审核", exact: true }).click();
  await page.getByRole("button", { name: "审核发布", exact: true }).click();
  await page.getByLabel("操作说明", { exact: true }).fill("Synthetic P6 operator explicitly publishes only this knowledge card");
  await page.getByRole("button", { name: "确认审核发布", exact: true }).click();
  await expect(page.getByText("已启用 V" + version + "。", { exact: true })).toBeVisible();
}

async function knowledge(page: Page, f: Fixture, suffix: string) {
  const title = "Synthetic P6 " + suffix + " " + f.nonce.slice(0, 8), body = f.seed.query + " V1 original published operating guidance";
  await page.goto("/knowledge");
  await page.getByRole("button", { name: "新建知识", exact: true }).click();
  await page.getByLabel("知识标题", { exact: true }).fill(title);
  await page.getByLabel("知识正文", { exact: true }).fill(body);
  await page.getByRole("combobox", { name: "主题", exact: true }).selectOption("operations");
  await page.getByRole("combobox", { name: "适用平台", exact: true }).selectOption("all");
  await page.getByLabel("适用站点", { exact: true }).fill("ALL");
  const productScope = page.getByRole("combobox", { name: "适用商品", exact: true });
  await productScope.selectOption(f.seed.spuId); await expect(productScope).toHaveValue(f.seed.spuId);
  await page.getByLabel("来源名称", { exact: true }).fill("Synthetic governed internal SOP");
  await page.getByLabel("负责人", { exact: true }).fill("Synthetic personal operator");
  await page.getByLabel("保存说明", { exact: true }).fill("Synthetic P6 product-specific knowledge source");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("草稿已保存，提交并审核发布后供 AI 使用", { exact: true })).toBeVisible();
  const entry = (await centerApi<KnowledgeWorkspace>("knowledge/workspace")).entries.find(row => row.latest.title === title);
  expect(entry).toBeDefined();
  expect(entry!.latest.spuId).toBe(f.seed.spuId);
  await publish(page, 1);
  return { id: entry!.id, title, body };
}

async function archive(f: Fixture, id?: string) {
  await f.restore();
  if (!id) return;
  const entry = (await centerApi<KnowledgeWorkspace>("knowledge/workspace")).entries.find(row => row.id === id);
  if (entry) await centerApi("knowledge/" + id + "/archive", { expectedRevision: entry.revision, version: entry.latestVersion,
    reason: "Synthetic P6 fixture teardown; immutable history remains in the disposable database until runner teardown", requestId: randomUUID() });
}

async function frames(page: Page, info: TestInfo, stem: string) {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(stem + "-" + width + ".png"), fullPage: false });
  }
  await page.setViewportSize({ width: 1440, height: 960 });
}

test("P6 product-scoped knowledge and original stock requisition use actual personal confirmation and GET-only lost-ACK recovery", async ({ page }, info) => {
  const f = await p6KnowledgeAgentFixture("original-command");
  let entryId: string | undefined;
  let releaseAck: () => void = () => {};
  const posts: string[] = [], proof: Record<string, unknown> = { nonce: f.nonce, realPaidProviderCalls: 0, ordinaryWorkerStarted: false,
    webPaidStartButtonExercised: false, nativeProcessor: "actual original Redis envelope with owned synthetic loopback Responses",
    scope: "product_scoped_knowledge_and_original_stock_requisition", productStockSkuOrBomLinkExercised: false };
  page.on("request", request => { const path = new URL(request.url()).pathname; if (request.method() === "POST" && /^\/api\/agent-/.test(path)) posts.push(path); });
  try {
    await loginErp(page, "operator", "/knowledge");
    const card = await knowledge(page, f, "native original"); entryId = card.id;
    await page.goto("/ai-tasks");
    const native = page.locator("section.agent-native-task-frame").filter({ hasText: "独立 v4" });
    await expect(native).toHaveCount(1);
    const composer = native.locator("details.an-composer");
    if (!await composer.evaluate(element => (element as HTMLDetailsElement).open)) await composer.locator(":scope > summary").click();
    await native.getByRole("combobox", { name: "选择本次读取工具", exact: true }).selectOption("knowledge.search");
    const picker = native.getByRole("region", { name: "知识产品选择", exact: true });
    await expect(picker.getByRole("combobox", { name: "知识产品范围", exact: true })).toHaveValue("");
    await picker.getByRole("textbox", { name: "搜索知识产品", exact: true }).fill(f.nonce.slice(0, 8));
    const productRead = page.waitForResponse(value => value.request().method() === "GET" && new URL(value.url()).pathname === "/api/knowledge/product-options");
    await picker.getByRole("button", { name: "读取产品候选", exact: true }).click();
    expect((await productRead).status()).toBe(200);
    await picker.getByRole("combobox", { name: "知识产品范围", exact: true }).selectOption(f.seed.spuId);
    await native.getByRole("combobox", { name: "知识主题", exact: true }).selectOption("operations");
    await native.getByRole("button", { name: "确定原知识范围", exact: true }).click();
    await native.getByRole("button", { name: "加入本次固定读取范围", exact: true }).click();
    await expect(composer.locator(".anv2-bindings > ol > li")).toHaveCount(1);
    await expect(composer.locator(".anv2-bindings code")).toHaveText(f.seed.spuId);
    const plan = await f.plan(card.id, 1), before = await f.nativeState();
    expect(plan.knowledgeEntryId).toBe(card.id); expect(plan.knowledgeVersion).toBe(1); expect(before.providerFailures).toBe(0);
    await page.goto("/ai-tasks?agentNativeV4=" + plan.runId);
    const proposals = page.getByRole("region", { name: "逐项核对模型业务与履约提案", exact: true });
    const item = proposals.getByRole("listitem", { name: "模型原提案 1", exact: true });
    await expect(item).toContainText("P6 internal requisition only");
    const href = "/knowledge?entry=" + card.id + "&version=1";
    await expect(page.getByRole("link", { name: "核对原知识 V1", exact: true }).first()).toHaveAttribute("href", href);
    const preparedResponse = page.waitForResponse(value => value.request().method() === "POST" && new URL(value.url()).pathname ===
      "/api/agent-native-v4/runs/" + plan.runId + "/items/" + plan.itemId + "/prepare");
    await item.getByRole("button", { name: "保存这项原准备并核对", exact: true }).click();
    const preparedHttp = await preparedResponse; expect(preparedHttp.status()).toBe(201);
    const prepared = AgentNativeV4ItemReceiptSchema.parse(await preparedHttp.json());
    expect(prepared.disposition).toBe("known"); expect(prepared.agentCommandId).not.toBeNull();
    expect((await f.nativeState()).requisitions).toBe(before.requisitions);
    const commandId = prepared.agentCommandId!, confirmPath = "/api/agent-commands/requests/" + commandId + "/confirm";
    const originalPrepared = AgentCommandViewSchema.parse(await centerApi("agent-commands/requests/" + commandId));
    const originalInput = originalPrepared.snapshot?.original;
    if (originalInput?.domain !== "procurement" || originalInput.command.kind !== "requisition_create")
      throw new Error("p6_original_stock_requisition_input_missing");
    expect(originalInput.command.input.lines.map(line => line.stockItemId)).toEqual([f.seed.stockItemId]);
    let confirmed: ReturnType<typeof AgentCommandViewSchema.parse> | undefined;
    let markExecuted: () => void = () => {};
    const executed = new Promise<void>(accept => { markExecuted = accept; });
    const allowAbort = new Promise<void>(accept => { releaseAck = accept; });
    await page.route("**" + confirmPath, async route => {
      const response = await route.fetch(); expect(response.status()).toBe(200);
      confirmed = AgentCommandViewSchema.parse(await response.json()); expect(confirmed.state).toBe("succeeded");
      const actualInput = confirmed.snapshot?.original;
      if (actualInput?.domain !== "procurement" || actualInput.command.kind !== "requisition_create")
        throw new Error("p6_confirmed_stock_requisition_input_missing");
      expect(actualInput.command.input.lines.map(line => line.stockItemId)).toEqual([f.seed.stockItemId]);
      markExecuted(); await allowAbort; await route.abort("failed");
    }, { times: 1 });
    const review = page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true });
    await expect(review).toBeVisible(); await expect(review).toContainText(f.seed.requisitionCode);
    await review.getByRole("checkbox", { name: "我已核对这笔原目标 原版本 全部原填写与业务影响 明确执行原提交", exact: true }).check();
    await review.getByRole("button", { name: "确认执行这笔原操作", exact: true }).click();
    await executed; releaseAck();
    await expect.poll(() => posts.filter(path => path === confirmPath).length).toBe(1);
    await page.reload();
    const recovered = page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true });
    await expect(recovered).toBeVisible();
    await expect(recovered.getByText("原业务结果已登记", { exact: true })).toBeVisible();
    await expect(recovered.getByRole("region", { name: "原业务真实状态与回执", exact: true })
      .getByText("原业务实际结果已登记", { exact: true })).toBeVisible();
    await expect(recovered.getByRole("button", { name: "确认执行这笔原操作", exact: true })).toHaveCount(0);
    const after = await f.nativeState(commandId);
    expect(after.requisitions - before.requisitions).toBe(1); expect(after.commandState).toBe("succeeded");
    expect(after.modelCalls).toBe(plan.modelCalls); expect(after.parentChecksum).toBe(before.parentChecksum); expect(after.providerFailures).toBe(0);
    expect(posts.filter(path => path.endsWith("/prepare"))).toHaveLength(1); expect(posts.filter(path => path.endsWith("/confirm"))).toEqual([confirmPath]);
    await frames(page, info, "p6-original-receipt");
    Object.assign(proof, { seed: f.seed, plan, commandId, originalStockItemIds: originalInput.command.input.lines.map(line => line.stockItemId),
      confirmation: confirmed?.state, before, after, originalPosts: posts, lostAck: true, recoveredByGetOnly: true });
  } finally {
    releaseAck();
    try { await archive(f, entryId); } finally { await f.close(); }
    await writeFile(info.outputPath("p6-original-command-proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" });
  }
});

test("P6 personal product knowledge keeps V1 immutable and clears disabled or revoked answers including a late original response", async ({ page }, info) => {
  await page.clock.install();
  const f = await p6KnowledgeAgentFixture("knowledge-version");
  let entryId: string | undefined, releaseLate: () => void = () => {};
  const proof: Record<string, unknown> = { nonce: f.nonce, realPaidProviderCalls: 0, ordinaryWorkerStarted: false };
  let answerPosts = 0;
  page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/ai-assists/runs") answerPosts++; });
  try {
    await loginErp(page, "operator", "/knowledge");
    const card = await knowledge(page, f, "versioned answer"); entryId = card.id;
    await page.goto("/knowledge?tab=chat");
    let chat = page.getByRole("region", { name: "知识对话", exact: true });
    await chat.getByRole("combobox", { name: "产品", exact: true }).selectOption(f.seed.spuId);
    await chat.getByRole("combobox", { name: "主题", exact: true }).selectOption("operations");
    await chat.getByRole("combobox", { name: "已配置模型", exact: true }).selectOption(f.model.modelId);
    await chat.getByRole("textbox", { name: "问题或追问", exact: true }).fill(f.seed.query);
    const startedResponse = page.waitForResponse(value => value.request().method() === "POST" && new URL(value.url()).pathname === "/api/ai-assists/runs");
    await chat.getByRole("button", { name: "发送并检索知识", exact: true }).click();
    const startedHttp = await startedResponse; expect(startedHttp.status()).toBe(201);
    const run = AssistViewSchema.parse(await startedHttp.json());
    if (run.request?.kind !== "knowledge_answer") throw new Error("p6_original_knowledge_request_missing");
    const scopeId = run.request.scopeId;
    expect(run.knowledge.some(ref => ref.entryId === card.id && ref.version === 1)).toBe(true);
    await f.model.answer(run.id);
    await chat.getByRole("button", { name: "刷新回答", exact: true }).click();
    await expect(chat.getByText(answer, { exact: true }).first()).toBeVisible();
    const href = "/knowledge?entry=" + card.id + "&version=1";
    await expect(chat.locator('.kb-reference a[href="' + href + '"]')).toHaveCount(1);
    await expect(chat.locator('.kb-reference a[href="' + href + '"]')).toHaveText(card.title + " · V1");
    const completed = AssistViewSchema.parse(await centerApi("ai-assists/runs/" + run.id));
    const calls = f.model.modelCalls(); expect(calls).toBe(1);
    let captured: () => void = () => {};
    const capturedResponse = new Promise<void>(accept => { captured = accept; });
    const pendingResponse = new Promise<void>(accept => { releaseLate = accept; });
    await page.route("**/api/ai-assists/runs/" + run.id, async route => {
      const response = await route.fetch(); expect(response.status()).toBe(200); captured(); await pendingResponse; await route.fulfill({ response });
    }, { times: 1 });
    await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await capturedResponse;
    await f.removeWorkflowRead();
    const denied = page.waitForResponse(value => value.request().method() === "GET" && new URL(value.url()).pathname === "/api/ai-assists/runs/" + run.id && value.status() === 403);
    await page.clock.fastForward(31_000); await denied;
    await expect(chat.getByText(answer, { exact: true })).toHaveCount(0);
    await expect(chat.getByRole("textbox", { name: "问题或追问", exact: true })).toHaveValue("");
    const late = page.waitForResponse(value => new URL(value.url()).pathname === "/api/ai-assists/runs/" + run.id && value.status() === 200);
    releaseLate(); await (await late).finished(); await page.clock.runFor(100);
    await expect(chat.getByText(answer, { exact: true })).toHaveCount(0);
    await expect(chat.locator('a[href="' + href + '"]')).toHaveCount(0);
    await f.restore();
    await page.goto(href);
    await expect(detail(page).getByRole("combobox", { name: "查看版本", exact: true })).toHaveValue("1");
    await page.getByRole("button", { name: "修订知识", exact: true }).click();
    const revised = f.seed.query + " V2 separately reviewed guidance";
    await page.getByLabel("知识正文", { exact: true }).fill(revised);
    await page.getByLabel("保存说明", { exact: true }).fill("Synthetic new version without rewriting V1");
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    await publish(page, 2);
    await page.goto(href);
    await expect(detail(page).getByRole("combobox", { name: "查看版本", exact: true })).toHaveValue("1");
    await expect(detail(page).locator(".kb-body")).toHaveText(card.body);
    await expect(detail(page).locator(".kb-body")).not.toHaveText(revised);
    await page.getByRole("button", { name: "查看最新版本", exact: true }).click();
    await expect(detail(page).getByRole("combobox", { name: "查看版本", exact: true })).toHaveValue("2");
    await page.getByRole("button", { name: "停用", exact: true }).click();
    await page.getByLabel("操作说明", { exact: true }).fill("Synthetic source intentionally no longer current");
    await page.getByRole("button", { name: "确认停用", exact: true }).click();
    await page.goto("/knowledge?tab=chat"); chat = page.getByRole("region", { name: "知识对话", exact: true });
    await chat.getByRole("combobox", { name: "最近对话", exact: true }).selectOption(scopeId);
    await expect(chat.locator(".kb-answer > .kb-meta").first()).toHaveText(f.seed.query + " · 原依据已变化");
    await expect(chat.getByText(answer, { exact: true })).toHaveCount(0);
    await expect(chat.locator('a[href="' + href + '"]')).toHaveCount(0);
    await expect(chat.getByText("本次固定引用当前不可读", { exact: true })).toBeVisible();
    const stale = AssistViewSchema.parse(await centerApi("ai-assists/runs/" + run.id));
    expect(stale.status).toBe(completed.status); expect(stale.costUsd).toBe(completed.costUsd);
    expect(stale.inputTokens).toBe(completed.inputTokens); expect(stale.outputTokens).toBe(completed.outputTokens); expect(stale.result).toBeNull();
    expect(f.model.modelCalls()).toBe(calls); expect(answerPosts).toBe(1);
    expect(f.context.permissions.includes(Permission.WorkflowRead)).toBe(true);
    await frames(page, info, "p6-stale-original-answer");
    Object.assign(proof, { cardId: card.id, spuId: f.seed.spuId, runId: run.id, fixedV1Href: href, activeV2ThenDisabled: true,
      explicitKnowledgePublicationOnly: true, lateResponseCannotRepaint: true, syntheticModelCalls: calls, answerPosts,
      originalStatus: completed.status, finalStatus: stale.status, costPreserved: true });
  } finally {
    releaseLate();
    try { await archive(f, entryId); } finally { await f.close(); }
    await writeFile(info.outputPath("p6-fixed-knowledge-proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" });
  }
});
