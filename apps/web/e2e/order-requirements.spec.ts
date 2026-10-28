import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChildProcess } from "node:child_process";
import { expect, test, type Locator, type Page, type Request, type TestInfo } from "@playwright/test";
import { createEntityId, type ProductionEditorDetailView } from "@yummyai/contracts";
import type { ConfigurationSnapshot } from "@yummyai/contracts/ai/model-configuration";
import { AssistViewSchema, CreateAssistSchema, type CreateAssist } from "@yummyai/contracts/ai/assist";
import type { DesignAutomationRecipe } from "@yummyai/contracts/pod/design-automation";
import { OrderIntakeCheckViewSchema, OrderWorkDetailViewSchema, type OrderIntakeCheck } from "@yummyai/contracts/order/workspace";
import type { DesignAgentRunView } from "@yummyai/contracts/order/design-agent";
import { ProductionEditorDetailViewSchema } from "@yummyai/contracts/pod/production-editor-api";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";
import { loginErp } from "./erp-identity-fixture";
import { centerApi } from "./order-centers-fixture";
import { orderIntakePillowFixture, type OrderIntakePillowFixture } from "./order-intake-pillow-fixture";
import { startProductionEditorWorker, stopProductionEditorWorker } from "./production-editor-fixture";

test.describe("order requirements personal source interpretation and Agent-first review", () => {
  test.beforeEach(async ({ page }) => {
    requireDisposableIntegrationEnvironment();
    expect(process.env.E2E_ORDER_REQUIREMENTS_ISOLATED).toBe("1");
    expect(process.env.WEB_AUTH_MODE).toBe("personal");
    await loginErp(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });

  test("order requirements keeps real text groups and styles while explicit priced analysis adopts one unsaved original operator field", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const modelName = "Synthetic requirement analysis " + createEntityId().slice(-8);
    const configuration = await centerApi<ConfigurationSnapshot>("ai/configuration", { operation: "channel.save", name: modelName,
      baseUrl: "https://synthetic-order-requirements.invalid/v1", apiKey: "synthetic-order-requirements-not-a-real-key", models: [] });
    const provider = configuration.channels.find(channel => channel.name === modelName)!;
    const analysisModel = await centerApi<{ id: string }>("ai-assists/models", { providerConfigId: provider.id,
      model: "synthetic-order-requirements-text", label: modelName, inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxTaskCostUsd: 1 });
    const f = await orderIntakePillowFixture(true, { operatorMessage: true, textGroups: [
      { label: "Custom your text", value: "Synthetic Alpha", font: "Luckiest Guy", colorLabel: "CustomColor" },
      { label: "Back custom text", value: "Synthetic Beta", font: "Synthetic Serif", colorLabel: "Original Blue", colorHex: "#1234ab" },
      { label: "Empty custom text", value: "", font: "Synthetic Empty Font", colorLabel: "Black", colorHex: "#000000" },
    ] });
    const audit = watch(page, f), before = structuredClone(f.initial.draft);
    let completed = false, child: ChildProcess | undefined, modelCalls = 0, output = "";
    const layouts: Array<Awaited<ReturnType<typeof stableScreenshotLayout>>> = [];
    let analysisProof: { runId: string; requestId: string; operatorSourceKey: string; adopted: boolean } | undefined;
    const countCalls = (chunk: Buffer) => {
      output += chunk.toString(); const lines = output.split("\n"); output = lines.pop()!;
      for (const line of lines) if (line.trim() === "SYNTHETIC_ORDER_REQUIREMENTS_ASSIST_CALL") modelCalls++;
    };
    try {
      const loaded = nextCheck(page, f, check => check.ready);
      await page.goto(f.url); await loaded;
      const whole = order(page), groups = whole.getByRole("region", { name: "分组印字要求", exact: true });
      await expect(groups.locator("fieldset.oc-requirement-text")).toHaveCount(3);
      const alpha = groups.getByRole("group", { name: "Custom your text", exact: true });
      const beta = groups.getByRole("group", { name: "Back custom text", exact: true });
      const empty = groups.getByRole("group", { name: "Empty custom text", exact: true });
      await expect(alpha.getByRole("textbox", { name: "印字内容 Custom your text", exact: true })).toHaveValue("Synthetic Alpha");
      await expect(alpha).toContainText("Luckiest Guy");
      await expect(alpha).toContainText("CustomColor · 未提供真实色值");
      await expect(alpha).not.toContainText("#000000");
      await expect(beta).toContainText("Synthetic Serif"); await expect(beta).toContainText("#1234ab");
      await expect(empty.getByRole("status")).toHaveText("无需印字");
      await expect(empty.locator("dl")).toHaveCount(0);
      await expect(whole.getByRole("combobox", { name: "设计执行方式", exact: true })).toHaveCount(0);
      await expect(whole.getByRole("button", { name: "改由美工制作", exact: true })).toHaveCount(0);
      await expect(whole.getByText("先由 Agent 出稿", { exact: true })).toBeVisible();
      const edited = nextCheck(page, f, check => check.normalizedDraft.fields.some(row => row.value === "Synthetic edited Alpha"));
      await alpha.getByRole("textbox", { name: "印字内容 Custom your text", exact: true }).fill("Synthetic edited Alpha");
      await edited;
      await alpha.locator("summary").filter({ hasText: /^调整本组字体与颜色$/ }).click();
      await alpha.getByRole("textbox", { name: "指定字体 Custom your text", exact: true }).fill("Synthetic Manual Font");
      await alpha.getByRole("textbox", { name: "实际色值 Custom your text", exact: true }).fill("#2468ac");
      await expect(confirm(page)).toBeDisabled();
      const styled = nextCheck(page, f, check => check.ready && check.normalizedDraft.fields.some(row => row.styleOverride?.colorHex === "#2468ac"));
      await alpha.getByRole("button", { name: "采用本组样式", exact: true }).click();
      const checked = await styled;
      expect(checked.requirements!.texts.find(row => row.originalText === "Synthetic edited Alpha"))
        .toMatchObject({ needsPrinting: true, font: { requested: "Synthetic Manual Font" }, color: { hex: "#2468ac" } });
      expect(checked.requirements!.texts.find(row => row.originalText === "Synthetic Beta"))
        .toMatchObject({ font: { requested: "Synthetic Serif" }, color: { hex: "#1234ab" } });
      expect(checked.requirements!.texts.find(row => row.originalText === "")!.needsPrinting).toBe(false);
      const advanced = whole.locator("details.oc-review-raw-fields");
      await advanced.locator("summary").click();
      await advanced.getByRole("button", { name: "添加定制字段", exact: true }).click();
      const added = advanced.locator(".oc-custom-field").last();
      const operatorSourceKey = await added.getAttribute("data-review-field");
      expect(operatorSourceKey).toMatch(/^operator\.[a-f0-9-]{36}$/);
      await added.getByRole("textbox", { name: "字段名称", exact: true }).fill("Synthetic operator message");
      const operatorChecked = nextCheck(page, f, check => check.ready && check.requirements?.sources.some(source =>
        source.sourceFieldKey === operatorSourceKey && source.origin === "operator" && source.value === "Synthetic operator original text") === true);
      await added.getByRole("textbox", { name: "定制内容", exact: true }).fill("Synthetic operator original text");
      await operatorChecked;
      const analysis = whole.locator("details.oc-review-ai");
      await expect(analysis).toHaveCount(1);
      await expect(analysis.locator(":scope > summary")).toHaveText("AI 辅助填写字段对应关系");
      await analysis.locator(":scope > summary").click();
      const model = analysis.getByRole("combobox", { name: "图文模型", exact: true });
      await expect(model).toHaveValue("");
      await expect(analysis.getByRole("button", { name: "AI分析并填写", exact: true })).toBeDisabled();
      expect(audit.analysisPosts).toEqual([]);
      await model.selectOption(analysisModel.id);
      await expect(analysis).toContainText("输入 $1/百万 tokens 输出 $2/百万 tokens 单次费用上限 $1");
      const start = analysis.getByRole("button", { name: "AI分析并填写", exact: true });
      await expect(start).toBeEnabled();
      child = await startProductionEditorWorker(); child.stdout?.on("data", countCalls);
      const posted = page.waitForResponse(value => path(value.url()) === "/api/ai-assists/runs" && value.request().method() === "POST");
      const adopted = nextCheck(page, f, check => check.ready && check.normalizedDraft.fields.some(field =>
        field.key === "operator_message" && field.sourceKey === operatorSourceKey && field.value === "Synthetic operator original text"));
      await start.click();
      const reply = await posted; expect(reply.ok()).toBe(true);
      const created = AssistViewSchema.parse(await reply.json());
      expect(created.request).toMatchObject({ kind: "order_review", orderLineId: f.lineId, modelId: analysisModel.id,
        expectedRevision: f.initial.line.revision, expectedSourceVersionId: f.sourceVersionId });
      if (created.request?.kind !== "order_review") throw new Error("Original order analysis request required");
      expect(created.request.draft!.fields.find(field => field.key === operatorSourceKey)!.value).toBe("Synthetic operator original text");
      const originalRequestId = created.request.requestId;
      analysisProof = { runId: created.id, requestId: originalRequestId, operatorSourceKey: operatorSourceKey!, adopted: false };
      const filled = await adopted;
      expect(filled.normalizedDraft.fields.find(field => field.key === "operator_message"))
        .toMatchObject({ value: "Synthetic operator original text", sourceKey: operatorSourceKey });
      await expect(advanced.locator('.oc-custom-field[data-review-field="operator_message"]').getByRole("textbox", { name: "定制内容", exact: true }))
        .toHaveValue("Synthetic operator original text");
      const originalResult = AssistViewSchema.parse(await centerApi(`ai-assists/runs/${created.id}`));
      expect(originalResult).toMatchObject({ status: "completed", stale: false, request: { requestId: originalRequestId } });
      expect(originalResult.costUsd).toBeCloseTo(0.00028, 8);
      expect(originalResult.result!.orderFieldBindings).toEqual([expect.objectContaining({ sourceFieldKey: operatorSourceKey,
        targetFieldKey: "operator_message", confidence: 0.98, role: "text" })]);
      expect(filled.normalizedDraft.fields.find(field => field.label === "Custom your text"))
        .toMatchObject({ value: "Synthetic edited Alpha", styleOverride: { source: "operator", font: "Synthetic Manual Font", colorHex: "#2468ac" } });
      expect(filled.requirements!.texts.find(row => row.originalText === "Synthetic Beta"))
        .toMatchObject({ font: { requested: "Synthetic Serif" }, color: { hex: "#1234ab" } });
      expect(filled.normalizedDraft.images).toEqual(before.images);
      expect(audit.analysisPosts).toHaveLength(1); expect(modelCalls).toBe(1);
      analysisProof.adopted = true;
      expect((await f.readDetail()).draft).toEqual(before);
      await groups.scrollIntoViewIfNeeded();
      layouts.push(await stableScreenshotLayout(page, groups));
      await page.screenshot({ path: testInfo.outputPath("grouped-requirements-desktop.png") });
      const response = page.waitForResponse(value => path(value.url()) === draftPath(f) && value.request().method() === "POST");
      await confirm(page).click();
      const actual = await response; expect(actual.ok()).toBe(true);
      const saved = OrderWorkDetailViewSchema.parse(await actual.json());
      expect(saved.draft.designExecutor).toBe("agent");
      expect(saved.draft.images).toEqual(before.images);
      expect(saved.draft).toMatchObject({ artworkVersionId: before.artworkVersionId, specificationVersionId: before.specificationVersionId,
        printProfileVersionId: before.printProfileVersionId, instructions: before.instructions });
      expect(saved.draft.fields.find(row => row.label === "Custom your text")).toMatchObject({ value: "Synthetic edited Alpha",
        styleOverride: { source: "operator", font: "Synthetic Manual Font", colorHex: "#2468ac" } });
      expect(saved.line).toMatchObject({ preparation: "ready_to_push", artwork: "not_pushed", production: "not_released" });
      expect((await f.readDetail()).draft).toEqual(saved.draft);
      await f.assertOriginalPreserved();
      await expect(intake(page)).toContainText("审单已确认");
      await page.setViewportSize({ width: 390, height: 844 }); await groups.scrollIntoViewIfNeeded();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      layouts.push(await stableScreenshotLayout(page, groups));
      await page.screenshot({ path: testInfo.outputPath("grouped-requirements-390.png") });
      expect(audit.actions).toEqual([]); expect(audit.otherWrites).toEqual([]); expect(audit.pageErrors).toEqual([]);
      completed = true;
    } finally { await stopProductionEditorWorker(child); child?.stdout?.off("data", countCalls); audit.stop();
      await proof(testInfo, f, completed, audit, !!child, analysisProof ? { ...analysisProof, providerCalls: modelCalls } : null, layouts); }
  });

  test("order requirements drafts with Agent first and allows an operator to reject the exact unapproved candidate to human editing", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const name = "Synthetic requirements " + createEntityId().slice(-8);
    const configuration = await centerApi<ConfigurationSnapshot>("ai/configuration", { operation: "channel.save", name,
      baseUrl: "https://synthetic.invalid/v1", apiKey: "synthetic-never-used",
      models: [{ name: "gpt-image-2.5", capability: "image", label: "Synthetic requirement image route" }] });
    const model = configuration.channels.find(channel => channel.name === name)!.models[0]!;
    const automation: DesignAutomationRecipe = { schemaVersion: 1, workflow: "pillow_photo", imagePolicy: "faithful_enhancement",
      modelRouteId: model.id, allowOrderImageTransfer: true, modelCallLimit: 2, estimatedCostPerCallUsd: 0.1,
      maxEstimatedCostUsd: 0.2 };
    const f = await orderIntakePillowFixture(true, { automation }), audit = watch(page, f);
    let child: ChildProcess | undefined, completed = false, modelCalls = 0;
    let editorRoundTrip: EditorRoundTrip | null = null;
    const layouts: Array<Awaited<ReturnType<typeof stableScreenshotLayout>>> = [];
    try {
      const loaded = nextCheck(page, f, check => check.ready);
      await page.goto(f.url); await loaded;
      await expect(order(page).getByRole("region", { name: "分组印字要求", exact: true })).toContainText("无需印字");
      await expect(confirm(page)).toBeEnabled();
      const save = page.waitForResponse(value => path(value.url()) === draftPath(f) && value.request().method() === "POST");
      await confirm(page).click(); const savedReply = await save; expect(savedReply.ok()).toBe(true);
      const saved = OrderWorkDetailViewSchema.parse(await savedReply.json());
      expect(saved.draft.designExecutor).toBe("agent");
      await expect(intake(page)).toContainText("审单已确认");
      const pushed = await centerApi(`order-centers/lines/${f.lineId}/actions`, { action: "push", expectedRevision: saved.line.revision,
        expectedProjectionVersion: saved.line.projectionVersion, reason: "Synthetic explicit Agent-first fixture dispatch after UI intake",
        idempotencyKey: createEntityId() });
      OrderWorkDetailViewSchema.parse(pushed);
      child = await startProductionEditorWorker({ onModelCall: () => { modelCalls++; } });
      await expect.poll(async () => (await run(f.lineId))?.status, { timeout: 120_000 }).toBe("awaiting_review");
      const candidate = (await run(f.lineId))!;
      expect(candidate.completion?.evidence.automaticProductionApproval).toBe(false);
      const editor = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${candidate.projectId}`);
      expect(editor.version.id).toBe(candidate.currentEditorVersionId);
      expect(editor.version.document.confirmations.visualReview).toBe(false); expect(editor.version.reviewed).toBe(false);
      const preview = editor.renders.find(render => render.status === "completed" && render.versionId === editor.version.id)!;
      expect(preview.preflight!.productionReady).toBe(false);
      await page.goto("/order-artwork?" + new URLSearchParams({ accountId: f.accountId, q: f.externalId, line: f.lineId, queue: f.lineId }));
      const review = page.getByRole("region", { name: "生产图审核", exact: true });
      await expect(review.getByRole("heading", { name: /审核无人设计稿/ })).toBeVisible();
      await expect(review.getByRole("button", { name: "通过审核", exact: true })).toBeDisabled();
      const reject = review.getByRole("button", { name: "驳回并交美工修改", exact: true });
      await expect(reject).toBeDisabled();
      await review.getByRole("textbox", { name: "驳回理由", exact: true }).fill("Synthetic operator requests a rounder independent cut line Keep original photo and text");
      await expect(reject).toBeEnabled();
      await review.scrollIntoViewIfNeeded();
      layouts.push(await stableScreenshotLayout(page, review, true));
      await page.screenshot({ path: testInfo.outputPath("agent-candidate-before-operator-rejection-desktop.png") });
      const response = page.waitForResponse(value => path(value.url()) === actionsPath(f) && value.request().method() === "POST"
        && value.request().postDataJSON().action === "reject_artwork");
      await reject.click(); const actual = await response; expect(actual.ok()).toBe(true);
      const command = actual.request().postDataJSON();
      expect(command.expectedEditorVersionId).toBe(candidate.currentEditorVersionId);
      const handoff = OrderWorkDetailViewSchema.parse(await actual.json());
      expect(handoff.line).toMatchObject({ artwork: "changes_requested", designExecutor: "human", designCandidateReview: false,
        editorProjectId: editor.project.id, production: "not_released" });
      expect(handoff.draft).toEqual(saved.draft); expect(handoff.draft.designExecutor).toBe("agent");
      const stopped = (await run(f.lineId))!;
      expect(stopped).toMatchObject({ status: "cancelled", actualCostUsd: candidate.actualCostUsd, costStatus: candidate.costStatus,
        projectId: candidate.projectId, currentEditorVersionId: candidate.currentEditorVersionId });
      const unapproved = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${editor.project.id}`);
      expect(unapproved.version).toEqual(editor.version);
      expect(unapproved.version.reviewed).toBe(false);
      await f.assertOriginalPreserved();
      const design = order(page).getByRole("region", { name: "无人设计进度", exact: true });
      await expect(design.getByText("已交美工修改", { exact: true })).toBeVisible();
      const handoffUrl = page.url(), route = new URL(handoffUrl);
      expect(route.pathname).toBe("/order-artwork");
      expect(Object.fromEntries(route.searchParams)).toMatchObject({ accountId: f.accountId, q: f.externalId, line: f.lineId, queue: f.lineId });
      expect(route.searchParams.has("editor")).toBe(false);
      const continueEditing = design.getByRole("button", { name: "继续本单制作", exact: true });
      await expect(continueEditing).toBeVisible(); await expect(continueEditing).toBeEnabled();
      const openedReply = page.waitForResponse(value => path(value.url()) === `/api/production-editor/projects/${editor.project.id}`
        && value.request().method() === "GET" && value.ok());
      await continueEditing.click();
      const opened = ProductionEditorDetailViewSchema.parse(await (await openedReply).json());
      expect(opened.project.id).toBe(editor.project.id); expect(opened.version.id).toBe(candidate.currentEditorVersionId);
      const session = page.getByRole("region", { name: "当前任务生产作图", exact: true });
      await expect(session.getByRole("heading", { name: `${f.externalId} · 制作需求 V${handoff.line.revision}`, exact: true })).toBeVisible();
      await expect(session.getByRole("combobox", { name: "打开生产项目", exact: true })).toHaveValue(editor.project.id);
      await expect(session.getByRole("combobox", { name: "历史版本", exact: true })).toHaveValue(candidate.currentEditorVersionId!);
      await expect(session.getByRole("textbox", { name: "图稿名称", exact: true })).toHaveValue(unapproved.version.document.name);
      const openedRoute = new URL(page.url());
      expect(openedRoute.pathname).toBe(route.pathname);
      expect(Object.fromEntries(openedRoute.searchParams)).toMatchObject({ accountId: f.accountId, q: f.externalId,
        line: f.lineId, queue: f.lineId, editor: "1" });
      await session.getByRole("button", { name: "返回制图任务", exact: true }).click();
      await expect(session).toHaveCount(0); await expect(page).toHaveURL(handoffUrl);
      await expect(design.getByText("已交美工修改", { exact: true })).toBeVisible();
      await expect(review.getByRole("button", { name: "提交文件审核", exact: true })).toBeDisabled();
      await expect(review.getByRole("button", { name: "通过审核", exact: true })).toHaveCount(0);
      const returned = await f.readDetail();
      expect(returned.line).toMatchObject({ artwork: "changes_requested", designExecutor: "human", designCandidateReview: false,
        editorProjectId: editor.project.id, production: "not_released" });
      expect(returned.draft).toEqual(saved.draft);
      const retained = ProductionEditorDetailViewSchema.parse(await centerApi(`production-editor/projects/${editor.project.id}`));
      expect(retained.version).toEqual(unapproved.version); expect(retained.version.reviewed).toBe(false);
      await f.assertOriginalPreserved();
      editorRoundTrip = { projectId: editor.project.id, versionId: retained.version.id, lineId: f.lineId, queue: f.lineId,
        openMethod: "GET", closedWithoutChanges: true, remainedUnapproved: true };
      await page.setViewportSize({ width: 390, height: 844 });
      await design.getByText("已交美工修改", { exact: true }).scrollIntoViewIfNeeded();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      layouts.push(await stableScreenshotLayout(page, design, true));
      await page.screenshot({ path: testInfo.outputPath("operator-rejection-human-handoff-390.png") });
      expect(modelCalls).toBe(2); expect(audit.actions.map(row => row.action)).toEqual(["reject_artwork"]);
      expect(audit.analysisPosts).toEqual([]); expect(audit.otherWrites).toEqual([]); expect(audit.pageErrors).toEqual([]);
      completed = true;
    } finally { await stopProductionEditorWorker(child); audit.stop(); await proof(testInfo, f, completed, audit, true, null, layouts, editorRoundTrip); }
  });
});

const order = (page: Page) => page.getByRole("region", { name: "整单详情", exact: true });
const intake = (page: Page) => page.getByRole("region", { name: "定制订单承接核对", exact: true });
const confirm = (page: Page) => order(page).getByRole("button", { name: "确认本件审单", exact: true });
const path = (url: string) => new URL(url).pathname;
const draftPath = (f: OrderIntakePillowFixture) => `/api/order-centers/lines/${f.lineId}/draft`;
const actionsPath = (f: OrderIntakePillowFixture) => `/api/order-centers/lines/${f.lineId}/actions`;
async function nextCheck(page: Page, f: OrderIntakePillowFixture, predicate: (check: OrderIntakeCheck) => boolean) {
  const response = await page.waitForResponse(async value => path(value.url()) === `/api/order-centers/lines/${f.lineId}/intake-check`
    && value.request().method() === "POST" && value.ok() && predicate(OrderIntakeCheckViewSchema.parse(await value.json())));
  return OrderIntakeCheckViewSchema.parse(await response.json());
}
async function run(lineId: string) { return (await centerApi<{ run: DesignAgentRunView | null }>(`order-centers/lines/${lineId}/design-agent`)).run; }
async function stableScreenshotLayout(page: Page, target: Locator, inspectArtworkTable = false) {
  const observedRootTransitions: Array<{ pseudo: string; finite: boolean }> = [];
  // Let the real transition finish; do not disable animations to obtain a clean image.
  await expect.poll(async () => {
    const active = await page.evaluate(() => document.getAnimations().flatMap(animation => {
      const effect = animation.effect;
      if (!(effect instanceof KeyframeEffect) || effect.target !== document.documentElement ||
        !effect.pseudoElement?.startsWith("::view-transition-") || !effect.pseudoElement.includes("(root)") ||
        animation.playState !== "running" && !animation.pending) return [];
      return [{ pseudo: effect.pseudoElement, finite: Number.isFinite(Number(effect.getComputedTiming().endTime)) }];
    }));
    observedRootTransitions.push(...active);
    return active.length;
  }).toBe(0);
  await expect.poll(() => target.evaluate(async element => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const before = element.getBoundingClientRect();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const after = element.getBoundingClientRect();
    return before.width > 0 && before.height > 0 && [before.x - after.x, before.y - after.y,
      before.width - after.width, before.height - after.height].every(delta => Math.abs(delta) < 0.5);
  })).toBe(true);
  const geometry = await target.evaluate((element, inspectTable) => {
    const rect = element.getBoundingClientRect();
    const table = inspectTable ? document.querySelector<HTMLTableElement>(".oc-workbench > .oc-table-wrap > .oc-table") : null;
    const wrapper = table?.parentElement;
    const activeRootTransitions = document.getAnimations().filter(animation => animation.effect instanceof KeyframeEffect &&
      animation.effect.target === document.documentElement && animation.effect.pseudoElement?.startsWith("::view-transition-") &&
      animation.effect.pseudoElement.includes("(root)") && (animation.playState === "running" || animation.pending)).length;
    return { viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth, activeRootTransitions,
      target: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      artworkTable: table && wrapper ? { columns: table.tHead?.rows[0]?.cells.length ?? 0,
        firstColumnWidth: table.tHead?.rows[0]?.cells[0]?.getBoundingClientRect().width ?? 0,
        scrollWidth: wrapper.scrollWidth, clientWidth: wrapper.clientWidth, width: wrapper.getBoundingClientRect().width } : null };
  }, inspectArtworkTable);
  expect(geometry.activeRootTransitions).toBe(0);
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  if (inspectArtworkTable) {
    expect(geometry.artworkTable).not.toBeNull();
    expect(geometry.artworkTable!.columns).toBe(7);
    expect(geometry.artworkTable!.firstColumnWidth).toBeGreaterThanOrEqual(200);
    expect(geometry.artworkTable!.width).toBeLessThanOrEqual(geometry.viewportWidth);
    if (geometry.viewportWidth === 390) expect(geometry.artworkTable!.scrollWidth).toBeGreaterThan(geometry.artworkTable!.clientWidth);
  }
  return { ...geometry, observedRootTransitions, animationsDisabled: false };
}
function watch(page: Page, f: OrderIntakePillowFixture) {
  const analysisPosts: CreateAssist[] = [], actions: Array<{ action: string }> = [], otherWrites: string[] = [], pageErrors: string[] = [];
  const request = (value: Request) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(value.method()) || !path(value.url()).startsWith("/api/")) return;
    const pathname = path(value.url());
    if (value.method() === "POST" && pathname === "/api/ai-assists/runs") { analysisPosts.push(CreateAssistSchema.parse(value.postDataJSON())); return; }
    if (value.method() === "POST" && pathname === actionsPath(f)) { actions.push(value.postDataJSON()); return; }
    if (value.method() === "POST" && [draftPath(f), `/api/order-centers/lines/${f.lineId}/intake-check`, "/api/order-centers/summaries"].includes(pathname)) return;
    otherWrites.push(value.method() + " " + pathname);
  };
  const error = (value: Error) => pageErrors.push(value.message);
  page.on("request", request); page.on("pageerror", error);
  return { analysisPosts, actions, otherWrites, pageErrors, stop: () => { page.off("request", request); page.off("pageerror", error); } };
}
type EditorRoundTrip = { projectId: string; versionId: string; lineId: string; queue: string; openMethod: "GET";
  closedWithoutChanges: true; remainedUnapproved: true };
async function proof(info: TestInfo, f: OrderIntakePillowFixture, completed: boolean, audit: ReturnType<typeof watch>, workerStarted: boolean,
  analysis: { runId: string; requestId: string; operatorSourceKey: string; adopted: boolean; providerCalls: number } | null = null,
  screenshotLayouts: Array<Awaited<ReturnType<typeof stableScreenshotLayout>>> = [], editorRoundTrip: EditorRoundTrip | null = null) {
  const output = info.outputPath("order-requirements-proof.json"); await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ completed, nonce: f.nonce, lineId: f.lineId, sourceVersionId: f.sourceVersionId,
    originalSha256: f.buyerSha256, analysisPosts: audit.analysisPosts.length, uiActions: audit.actions.map(row => row.action),
    otherWrites: audit.otherWrites, pageErrors: audit.pageErrors, isolatedSyntheticTransportOnly: true,
    isolatedProductionFixtureWorkerStarted: workerStarted, ordinaryWorkerStarted: false, productionApproved: false,
    analysis, screenshotLayouts, editorRoundTrip,
    cleanupOwner: "native disposable runner finally DB bucket Redis identity Web sandbox; fixture child stopped explicitly" }, null, 2), { flag: "wx" });
}
