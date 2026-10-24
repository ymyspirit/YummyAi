import { syntheticSpecificationFacts } from "../../../tools/testing/specification-fixtures.js";
import { expect, test, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { createEntityId, type AmazonReportBatchView, type AmazonReportWorkspaceView, type MarketplaceAccountView, type ProductionEditorDetailView } from "@yummyai/contracts";
import type { OrderWorkDetail, PrintProfileView } from "@yummyai/contracts/order/workspace";
import type { DesignAgentRunView } from "@yummyai/contracts/order/design-agent";
import { createPillowPipeline, PILLOW_CONTOUR_GRAPH_VERSION, PillowRuntimeCapabilitySchema, type DesignAutomationRecipe } from "@yummyai/contracts/pod/design-automation";
import type { ConfigurationSnapshot } from "@yummyai/contracts/ai/model-configuration";
import type { AgentMethodWorkspace } from "@yummyai/contracts/harness/methods";
import { Permission } from "../../../packages/authz/src/index";
import { applyPillowFactoryStandard } from "@yummyai/production-editor/products";
import { apiFetch } from "../src/server-api";
import { centerApi, createCenterProfile, createCenterSpu } from "./order-centers-fixture";
import { pngResolution, startProductionEditorWorker, syntheticProductionPng } from "./production-editor-fixture";
import { workflowOperatorFixture } from "./workflow-operator-fixture";

const recipe: DesignAutomationRecipe = { schemaVersion: 1, workflow: "template", imagePolicy: "preserve", modelRouteId: null,
  allowOrderImageTransfer: false, modelCallLimit: 0, estimatedCostPerCallUsd: null, maxEstimatedCostUsd: null };

test.use({actionTimeout:15_000});

test("design agent processes a third product after page reload without auto-approving production", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const suffix = createEntityId().slice(-8);
  const originalMethod=await publishOrderMethod("Synthetic original order design procedure");
  const profile = await createCenterProfile("rectangular_print", `AGENT-${suffix}`, true, recipe);
  const order = await prepareOrder(profile.recipeId, suffix);
  let worker: ChildProcess | undefined;
  let access: Awaited<ReturnType<typeof workflowOperatorFixture>> | undefined;
  try {
    await openOrder(page, "/orders", order.externalId);
    await page.getByRole("button", { name: "推送本件设计", exact: true }).click();
    const initial = await waitRun(order.id);
    expect(initial).toMatchObject({ status: "queued", costStatus: "not_required" });
    expect(initial.methodSnapshot?.methodSelection).toMatchObject({mode:"published",version:originalMethod.activeVersion});
    await publishOrderMethod("Synthetic newer order design procedure");
    await page.reload();
    await openOrder(page, "/order-artwork", order.externalId);
    const panel = page.getByRole("region", { name: "无人设计进度" });
    await expect(panel.getByText("排队中", { exact: true })).toBeVisible();
    expect((await runView(order.id))?.id).toBe(initial.id);
    await page.getByText("处理与交接", { exact: true }).click();
    const note = page.getByLabel("操作原因 / 客户确认依据");
    await note.fill("Synthetic unsaved operator note");
    await expect(page.getByRole("button", { name: "领取并开始制作", exact: true })).toBeDisabled();
    worker = await startProductionEditorWorker();
    await expect.poll(async () => (await runView(order.id))?.status, { timeout: 90_000 }).toBe("awaiting_review");
    await expect(panel.getByText("稿件待审核", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole("listitem").filter({ hasText: "交付待核对稿件" }).getByText("待人工核对", { exact: true })).toBeVisible();
    await expect(note).toHaveValue("Synthetic unsaved operator note");
    await expect(page.getByText("自动制作状态已有更新，当前备注和修改仍保留。保存或清空修改后，将刷新稿件与审核信息。", { exact: true })).toBeVisible();
    await note.fill("");
    await expect(page.getByRole("region", { name: "生产图审核", exact: true })).toBeVisible();
    const completed = (await runView(order.id))!;
    expect(completed.methodSnapshot).toEqual(initial.methodSnapshot);
    expect(completed.completion?.evidence).toMatchObject({runId:initial.id,projectId:completed.projectId,editorVersionId:completed.currentEditorVersionId,requiresBusinessReview:true,automaticProductionApproval:false});
    const methodEvidence=panel.getByRole("region",{name:"本次固定的方法"});
    await expect(methodEvidence).toContainText(`团队方法 v${originalMethod.activeVersion}`);
    await expect(panel.getByLabel("原始制作交接")).toContainText("交由业务审核");
    const historyOpened=page.waitForEvent("popup");await methodEvidence.getByRole("link",{name:"查看此版本"}).click();
    const history=await historyOpened;await expect(history.getByRole("region",{name:"方法版本记录"})).toContainText("Synthetic original order design procedure");await expect(history).toHaveURL(new RegExp(`version=${originalMethod.activeVersion}`));await history.close();
    expect(completed.steps.some(step => step.status === "completed")).toBe(true);
    expect(completed.actualCostUsd).toBe(0);
    const project = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${completed.projectId}`);
    expect(project.version.document.productType).toBe("rectangular_print");
    expect(project.version.document.automation).toMatchObject(recipe);
    expect(project.version.reviewed).toBe(false);
    expect(project.version.document.confirmations.visualReview).toBe(false);
    const preview = project.renders.find(render => render.purpose === "preview" && render.status === "completed" && render.versionId === project.version.id);
    expect(preview).toBeTruthy();
    const image = preview!.files.find(file => file.mediaType === "image/png")!;
    const bytes = await apiFetch(`${process.env.API_BASE_URL}/v1/production-editor/projects/${project.project.id}/renders/${preview!.id}/files/${image.key}`);
    expect(bytes.ok).toBe(true);
    const proofBytes=Buffer.from(await bytes.arrayBuffer());expect(pngResolution(proofBytes)).toMatchObject({ width: 354, height: 236 });
    const handedOff=completed.completion!.evidence.proofs.find(proof=>proof.renderId===preview!.id)!.files.find(file=>file.key===image.key)!;
    expect(handedOff).toMatchObject({byteSize:proofBytes.byteLength,checksumSha256:createHash("sha256").update(proofBytes).digest("hex")});
    const blocked = await apiFetch(`${process.env.API_BASE_URL}/v1/production-editor/projects/${project.project.id}/renders`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersionId: project.version.id, purpose: "production", format: "png", background: "transparent" }),
    });
    expect(blocked.status).toBe(422);
    expect(await blocked.json()).toMatchObject({ message: "正式文件未生成，请处理预检问题。" });
    await page.screenshot({ path: testInfo.outputPath("design-agent-complete-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await methodEvidence.scrollIntoViewIfNeeded();await expect(methodEvidence).toBeInViewport();
    expect(await methodEvidence.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
    await methodEvidence.screenshot({path:testInfo.outputPath("design-agent-method-mobile.png")});
    await page.screenshot({ path: testInfo.outputPath("design-agent-complete-mobile.png"), fullPage: true });
    access=await workflowOperatorFixture();
    await assertCompletedOrderRevocation(page,order.id,access);
  } finally { worker?.kill();await access?.close(); }
});

test("design agent takeover survives a worker restart and preserves the recipe configuration", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const suffix = createEntityId().slice(-8);
  const profile = await createCenterProfile("tire_cover", `TAKEOVER-${suffix}`, true, recipe);
  const order = await prepareOrder(profile.recipeId, suffix);
  let worker: ChildProcess | undefined;
  try {
    await openOrder(page, "/orders", order.externalId);
    await page.getByRole("button", { name: "推送本件设计", exact: true }).click();
    await waitRun(order.id);
    const panel = page.getByRole("region", { name: "无人设计进度" });
    await panel.getByRole("button", { name: "停止自动制作并接管", exact: true }).click();
    await expect.poll(async () => (await runView(order.id))?.status).toBe("cancelled");
    worker = await startProductionEditorWorker();
    await page.reload();
    await openOrder(page, "/order-artwork", order.externalId);
    await expect(page.getByRole("region", { name: "无人设计进度" }).getByText("已停止自动制作", { exact: true })).toBeVisible();
    expect((await runView(order.id))?.status).toBe("cancelled");
    await page.getByText("处理与交接", { exact: true }).click();
    await page.getByRole("button", { name: "领取并开始制作", exact: true }).click();
    await expect.poll(async () => (await centerApi<OrderWorkDetail>(`order-centers/lines/${order.id}`)).line.editorProjectId).toBeTruthy();
    await page.goto(`/pod-workbench/production-editor?projectId=${profile.projectId}`);
    const settings = page.getByRole("region", { name: "自动制图配方" });
    await expect(settings.getByLabel("制作流程")).toHaveValue("template");
    await expect(settings.getByLabel("买家图片处理")).toHaveValue("preserve");
    await settings.getByLabel("买家图片处理").selectOption("faithful_enhancement");
    await expect(settings.getByLabel("每单模型调用次数上限")).toHaveValue("0");
    await expect(settings.getByRole("checkbox")).not.toBeChecked();
    await expect(settings.getByLabel("每次调用预估费用（USD）")).toHaveValue("");
    const model = settings.getByLabel("固定图像模型");
    await expect(model.locator("option")).toHaveCount(2);
    await model.selectOption({ index: 1 });
    await settings.getByRole("checkbox").check();
    await settings.getByLabel("每次调用预估费用（USD）").fill("0.2");
    await model.selectOption("");
    await expect(settings.getByRole("checkbox")).not.toBeChecked();
    await expect(settings.getByLabel("每次调用预估费用（USD）")).toHaveValue("");
    await page.getByRole("button", { name: "保存新版本", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "已保存版本" })).toBeVisible();
    await page.reload();
    await expect(settings.getByLabel("买家图片处理")).toHaveValue("faithful_enhancement");
    const unchanged = (await runView(order.id))!;
    expect(unchanged.status).toBe("cancelled");
    expect(unchanged.estimatedCostUsd).toBe(0);
    await expect.poll(async () => page.locator("canvas.lower-canvas").evaluate((canvas: HTMLCanvasElement) => {
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let at = 0; at < pixels.length; at += 4) if (pixels[at]! > 150 && pixels[at + 1]! < 130 && pixels[at + 2]! < 130 && pixels[at + 3]! > 200) return true;
      return false;
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("design-recipe-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("design-recipe-mobile.png"), fullPage: true });
  } finally { worker?.kill(); }
});

test("new pillow recipe explicitly opts into contour evidence, blocks changed fingerprints and fits desktop and mobile", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  // The suite owns a disposable DB/bucket. Model and upscale bytes are synthetic;
  // graph, Worker, commits, authenticated API, and UI are the real application.
  // Runtime capability still verifies the installed tool without running its GPU.
  const runtime = PillowRuntimeCapabilitySchema.parse(await centerApi("creative-studio/rpc", { operation: "pillow-runtime", scope: "unassigned" }));
  expect(runtime.available, runtime.reason ?? "Pinned Real-ESRGAN runtime must be installed for acceptance").toBe(true);
  expect(runtime.upscale).not.toBeNull();
  const suffix = createEntityId().slice(-8), channelName = `Synthetic pillow ${suffix}`;
  const configuration = await centerApi<ConfigurationSnapshot>("ai/configuration", { operation: "channel.save", name: channelName,
    baseUrl: "https://synthetic.invalid/v1", apiKey: "synthetic-never-used", models: [
      { name: "gpt-image-2.5", capability: "image", label: `Exact pillow image ${suffix}` },
      { name: "gpt-image-2.5-preview", capability: "image", label: `Incompatible pillow image ${suffix}` },
    ] });
  const channel = configuration.channels.find(value => value.name === channelName)!;
  const exact = channel.models.find(model => model.name === "gpt-image-2.5")!;
  const wrong = channel.models.find(model => model.name === "gpt-image-2.5-preview")!;
  const profile = await createCenterProfile("shaped_pillow", `PIPELINE-${suffix}`, false, recipe);
  let template = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${profile.projectId}`);
  expect(template.version.document.productType).toBe("shaped_pillow");
  if (template.version.document.productType !== "shaped_pillow") throw new Error("Synthetic pillow fixture has wrong type");
  template = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${profile.projectId}/versions`, {
    expectedVersionId: template.version.id, document: applyPillowFactoryStandard(template.version.document),
  });
  await page.goto(`/pod-workbench/production-editor?projectId=${profile.projectId}`);
  const settings = page.getByRole("region", { name: "自动制图配方" });
  await settings.getByLabel("制作流程").selectOption("pillow_photo");
  const enable = settings.getByRole("checkbox", { name: "启用新版抱枕链：主体测量与按需超分" });
  const contourWorkflow = settings.getByRole("checkbox", { name: "试用裁线检查与有限修正流程" });
  await expect(contourWorkflow).not.toBeChecked();
  await expect(contourWorkflow).toBeDisabled();
  await expect(enable).not.toBeChecked();
  await expect(enable).toBeEnabled();
  await enable.check();
  await expect(contourWorkflow).toBeEnabled();
  await expect(contourWorkflow).not.toBeChecked();
  await contourWorkflow.check();
  await expect(settings.getByLabel("买家图片处理")).toHaveValue("faithful_enhancement");
  await expect(settings.getByLabel("买家图片处理")).toBeDisabled();
  await expect(settings.getByText("尚未选择 gpt-image-2.5 图像模型，不能派发。", { exact: true })).toBeVisible();
  const model = settings.getByLabel("固定图像模型");
  // Playwright's disabled-state matcher normalizes an option to its select.
  // Verify the option's own native property and that keyboard selection skips it.
  await expect(model.locator(`option[value="${wrong.id}"]`)).toHaveJSProperty("disabled", true);
  await expect(model.locator(`option[value="${exact.id}"]`)).toHaveJSProperty("disabled", false);
  await model.focus();
  await model.press("Home");
  await expect(model).toHaveValue("");
  await model.press("End");
  await expect(model).toHaveValue(exact.id);
  await model.press("ArrowDown");
  await expect(model).toHaveValue(exact.id);
  await settings.getByRole("checkbox", { name: "已核对所选提供方，允许用于本配方的订单图片处理" }).check();
  await settings.getByLabel("每单模型调用次数上限").fill("2");
  await settings.getByLabel("每次调用预估费用（USD）").fill("0.1");
  await settings.getByLabel("每单预估费用上限（USD）").fill("0.2");
  await page.getByRole("button", { name: "保存新版本", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "已保存版本" })).toBeVisible();
  await page.reload();
  await expect(enable).toBeChecked();
  await expect(contourWorkflow).toBeChecked();
  await expect(model).toHaveValue(exact.id);
  await expect(settings.getByLabel("新版抱枕配方待处理")).toHaveCount(0);
  template = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${profile.projectId}`);
  expect(template.version.document.automation).toMatchObject({ workflow: "pillow_photo", imagePolicy: "faithful_enhancement", modelRouteId: exact.id,
    pillowPipeline: { version: "pillow-subject-v1-2026-09-19", upscale: runtime.upscale, contour: { workflow: PILLOW_CONTOUR_GRAPH_VERSION } } });
  await contourWorkflow.uncheck();
  await page.getByRole("button", { name: "保存新版本", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "已保存版本" })).toBeVisible();
  await page.reload();
  await expect(contourWorkflow).not.toBeChecked();
  template = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${profile.projectId}`);
  expect(template.version.document.automation?.pillowPipeline?.contour).not.toHaveProperty("workflow");
  await contourWorkflow.check();
  await page.getByRole("button", { name: "保存新版本", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "已保存版本" })).toBeVisible();
  template = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${profile.projectId}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("pillow-pipeline-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(enable).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("pillow-pipeline-mobile.png"), fullPage: true });

  // Applying the factory standard correctly revoked physical-size confirmation.
  // This fixture explicitly verifies its synthetic 10-inch manufacturing plan;
  // it does not confirm visual quality or approve any customer production file.
  expect(template.version.document.productType).toBe("shaped_pillow");
  if (template.version.document.productType !== "shaped_pillow") throw new Error("Synthetic pillow fixture has wrong type");
  expect(template.version.document.spec).toMatchObject({ factoryStandardId: "ps-pillow-2026-09-17", widthMm: 254, heightMm: 254,
    declaredLongestMm: 10 * 25.4, dpi: 150, sizeBasis: "artwork", artworkClipMode: "none" });
  expect(template.version.document.spec.whiteBorderMm).toBeCloseTo(200 * 25.4 / 150, 8);
  expect(template.version.document.spec.barcodeTab.widthMm).toBeCloseTo(600 * 25.4 / 150, 8);
  expect(template.version.document.spec.barcodeTab.heightMm).toBeCloseTo(200 * 25.4 / 150, 8);
  template.version.document.confirmations.physicalSize = true;
  template = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${profile.projectId}/versions`, {
    expectedVersionId: template.version.id, document: template.version.document,
  });
  template = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${profile.projectId}/review`, { expectedVersionId: template.version.id });
  expect(template.version.reviewed).toBe(true);
  expect(template.version.document.confirmations.physicalSize).toBe(true);
  let profiles = await centerApi<PrintProfileView[]>("order-centers/profiles", { code: profile.code, name: profile.name, projectId: profile.projectId,
    versionId: template.version.id, instructions: "Synthetic contour pilot; no customer artwork", expectedVersion: profile.versionNumber, idempotencyKey: randomUUID() });
  const accepted = profiles.find(value => value.id === profile.id)!;
  const completedOrder = await preparePillowOrder(accepted.versionId, suffix);
  let worker: ChildProcess | undefined;
  try {
    await openOrder(page, "/orders", completedOrder.externalId);
    await page.getByRole("button", { name: "推送本件设计", exact: true }).click();
    expect(await waitRun(completedOrder.id)).toMatchObject({ status: "queued" });
    worker = await startProductionEditorWorker();
    await expect.poll(async () => (await runView(completedOrder.id))?.status, { timeout: 120_000 }).toBe("awaiting_review");
    const completed = (await runView(completedOrder.id))!;
    const contour = completed.steps.find(step => step.key === "optimize_contour")!;
    expect(contour).toMatchObject({ status: "completed", contourEvidence: { workflowVersion: PILLOW_CONTOUR_GRAPH_VERSION,
      status: "passed", artworkUnchanged: true, manualReviewRequired: true } });
    expect(contour.contourEvidence!.sourceChecksum).toBe(contour.contourEvidence!.outputChecksum);
    expect(contour.contourEvidence!.attempts.length).toBeLessThanOrEqual(3);
    const project = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${completed.projectId}`);
    expect(project.version.reviewed).toBe(false);
    expect(project.version.document.confirmations.visualReview).toBe(false);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openOrder(page, "/order-artwork", completedOrder.externalId);
    const evidence = page.getByLabel("裁线执行证据", { exact: true });
    await evidence.locator("summary").click();
    await expect(evidence.getByText("锁定图案保持不变，输入与输出素材校验和一致。技术检查不代表人工审核或生产批准。", { exact: true })).toBeVisible();
    await expect(evidence.getByText(PILLOW_CONTOUR_GRAPH_VERSION, { exact: true })).toBeVisible();
    await expect(evidence.getByText("待人工核对", { exact: true }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("pillow-contour-evidence-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(evidence.getByText(PILLOW_CONTOUR_GRAPH_VERSION, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("pillow-contour-evidence-mobile.png"), fullPage: true });
  } finally { worker?.kill(); }

  // Change only the synthetic reviewed pin, never the installed shared tool or
  // runtime endpoint. A real dispatch must fail before reaching any provider.
  template.version.document.automation!.pillowPipeline!.upscale.modelBinSha256 = "d".repeat(64);
  template = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${profile.projectId}/versions`, {
    expectedVersionId: template.version.id, document: template.version.document,
  });
  template = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${profile.projectId}/review`, { expectedVersionId: template.version.id });
  await page.goto(`/pod-workbench/production-editor?projectId=${profile.projectId}`);
  await page.reload();
  await expect(settings.getByLabel("新版抱枕配方待处理")).toContainText("超分工具或模型指纹已变化");
  profiles = await centerApi<PrintProfileView[]>("order-centers/profiles", { code: profile.code, name: profile.name, projectId: profile.projectId,
    versionId: template.version.id, instructions: "Synthetic incompatible runtime pin", expectedVersion: accepted.versionNumber, idempotencyKey: randomUUID() });
  const updated = profiles.find(value => value.id === profile.id)!;
  const order = await preparePillowOrder(updated.versionId, `${suffix}-blocked`);
  await openOrder(page, "/orders", order.externalId);
  await page.getByRole("button", { name: "推送本件设计", exact: true }).click();
  const run = await waitRun(order.id);
  expect(run).toMatchObject({ status: "needs_attention", errorCode: "pillow_runtime_mismatch", modelRouteId: exact.id, projectId: null });
  expect(run.steps.every(step => step.attempt === 0)).toBe(true);
  await expect(page.getByRole("region", { name: "无人设计进度" }).getByText("需要处理", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("pillow-pipeline-runtime-blocked-mobile.png"), fullPage: true });
  // Failure-safe teardown belongs to the isolated runner, which destroys and
  // verifies the entire disposable DB/bucket/Redis even when an assertion fails.
});

test("pillow response recovery retains checkpoints across reload, renders a full JPG and returns rejected artwork through a new version", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const runtime = PillowRuntimeCapabilitySchema.parse(await centerApi("creative-studio/rpc", { operation: "pillow-runtime", scope: "unassigned" }));
  expect(runtime.available, runtime.reason ?? "Pinned pillow runtime required").toBe(true);
  if (!runtime.upscale) throw new Error("Synthetic recovery fixture requires pinned runtime fingerprints");
  const suffix = createEntityId().slice(-8), channelName = `Synthetic recovery ${suffix}`;
  const configuration = await centerApi<ConfigurationSnapshot>("ai/configuration", { operation: "channel.save", name: channelName,
    baseUrl: "https://synthetic.invalid/v1", apiKey: "synthetic-never-used", models: [{ name: "gpt-image-2.5", capability: "image", label: `Recovery image ${suffix}` }] });
  const model = configuration.channels.find(channel => channel.name === channelName)!.models[0]!;
  const pipeline = createPillowPipeline(runtime.upscale);
  pipeline.contour.workflow = PILLOW_CONTOUR_GRAPH_VERSION;
  const profile = await createCenterProfile("shaped_pillow", `RECOVERY-${suffix}`, false, recipe);
  let template = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${profile.projectId}`);
  if (template.version.document.productType !== "shaped_pillow") throw new Error("Wrong synthetic product");
  const document = applyPillowFactoryStandard(template.version.document);
  document.confirmations.physicalSize = true;
  document.automation = { schemaVersion: 1, workflow: "pillow_photo", imagePolicy: "faithful_enhancement", modelRouteId: model.id,
    allowOrderImageTransfer: true, modelCallLimit: 2, estimatedCostPerCallUsd: 0.1, maxEstimatedCostUsd: 0.2, pillowPipeline: pipeline };
  template = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${profile.projectId}/versions`, { expectedVersionId: template.version.id, document });
  template = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${profile.projectId}/review`, { expectedVersionId: template.version.id });
  const profiles = await centerApi<PrintProfileView[]>("order-centers/profiles", { code: profile.code, name: profile.name, projectId: profile.projectId,
    versionId: template.version.id, instructions: "Synthetic recovery fixture only", expectedVersion: profile.versionNumber, idempotencyKey: randomUUID() });
  const order = await preparePillowOrder(profiles.find(value => value.id === profile.id)!.versionId, suffix);
  let worker: ChildProcess | undefined, modelCalls = 0;
  try {
    await openOrder(page, "/orders", order.externalId);
    await page.getByRole("button", { name: "推送本件设计", exact: true }).click();
    await waitRun(order.id);
    worker = await startProductionEditorWorker({ fault: "unknown_pillow_cutout", onModelCall: () => { ++modelCalls; } });
    await expect.poll(async () => (await runView(order.id))?.errorCode, { timeout: 90_000 }).toBe("agent_model_submission_unknown");
    const paused = (await runView(order.id))!;
    expect(paused.canResume).toBe(false); expect(paused.responseRecoveryTarget?.stepLabel).toBe("主体抠图");
    expect(paused.steps.find(step => step.key === "enhance_image_1")!.status).toBe("completed"); expect(modelCalls).toBe(2);
    await page.reload();
    await openOrder(page, "/order-artwork", order.externalId);
    const panel = page.getByRole("region", { name: "无人设计进度" }), form = panel.getByLabel("核实模型结果并恢复", { exact: true });
    await expect(panel.getByLabel("制图衔接与恢复")).toContainText("最近完成：顾客图片保真美化");
    await form.locator("summary").click();
    await expect(form.getByText(paused.responseRecoveryTarget!.requestId, { exact: true })).toBeVisible();
    await expect(form.getByAltText("本步骤已固定的参考图片")).toHaveJSProperty("naturalWidth", 512);
    const restore = form.getByRole("button", { name: "导入原结果并继续制图", exact: true });
    await expect(restore).toBeDisabled();
    await form.getByLabel("提供方原结果文件", { exact: true }).setInputFiles({ name: "synthetic-invalid.png", mimeType: "image/png", buffer: Buffer.from("Synthetic non-image bytes") });
    await expect(form.getByText("待导入文件无法显示为图片，请重新选择提供方的原结果文件。", { exact: true })).toBeVisible();
    await expect(form.getByRole("checkbox")).toBeDisabled();
    await expect(restore).toBeDisabled();
    await form.getByLabel("提供方原结果文件", { exact: true }).setInputFiles({ name: "synthetic-original-response.png", mimeType: "image/png", buffer: syntheticProductionPng(640, true) });
    await form.getByLabel("提供方记录编号", { exact: true }).fill(`synthetic-result-${suffix}`);
    await form.getByLabel("核对依据", { exact: true }).fill("已核对合成提供方的原请求、参考图和未经修改的原返回图片。");
    await expect(restore).toBeDisabled();
    await expect(form.getByRole("checkbox")).toBeEnabled();
    await form.getByRole("checkbox").check();
    await expect(restore).toBeEnabled();
    await page.setViewportSize({ width: 1440, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("pillow-response-recovery-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 2000 });
    await panel.screenshot({ path: testInfo.outputPath("pillow-response-recovery-panel.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("pillow-response-recovery-mobile.png"), fullPage: true });
    await restore.click();
    await expect.poll(async () => (await runView(order.id))?.status, { timeout: 120_000 }).toBe("awaiting_review");
    const complete = (await runView(order.id))!;
    expect(complete.actualCostUsd).toBeNull(); expect(complete.costStatus).toBe("unknown"); expect(modelCalls).toBe(2);
    for (const step of paused.steps.filter(step => step.status === "completed")) expect(complete.steps.find(row => row.id === step.id)).toEqual(step);
    const imported = complete.steps.find(step => step.key === "cutout_subject")!;
    expect(imported.responseRecovery).toMatchObject({ kind: "operator_verified_provider_result", providerReference: `synthetic-result-${suffix}` });
    await expect(panel.getByText("稿件待审核", { exact: true })).toBeVisible();
    await expect(panel.getByLabel("人工恢复记录")).toContainText("人工核实并导入原结果");
    let project = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${complete.projectId}`);
    expect(project.version.reviewed).toBe(false); expect(project.version.document.confirmations.visualReview).toBe(false);
    const proof = project.renders.find(render => render.versionId === project.version.id && render.status === "completed" && render.purpose === "preview")!;
    expect(proof.files[0]!.mediaType).toBe("image/jpeg"); expect(proof.files[0]!.name).toMatch(/\.jpg$/);
    const response = await apiFetch(`${process.env.API_BASE_URL}/v1/production-editor/projects/${project.project.id}/renders/${proof.id}/files/${proof.files[0]!.key}`);
    expect(response.ok).toBe(true); expect(Buffer.from(await response.arrayBuffer()).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    const blocked = await apiFetch(`${process.env.API_BASE_URL}/v1/production-editor/projects/${project.project.id}/renders`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersionId: project.version.id, purpose: "production", format: "jpeg", background: "white" }) });
    expect(blocked.status).toBe(422);

    // Synthetic operator decisions exercise the real review loop. They never
    // approve customer artwork or claim factory acceptance/production release.
    project.version.document.confirmations = { physicalSize: true, visualReview: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true };
    project = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${project.project.id}/versions`, { expectedVersionId: project.version.id, document: project.version.document });
    const reviewedVersion = project.version.id;
    const act = async (action: "submit_artwork" | "reject_artwork") => {
      const detail = await centerApi<OrderWorkDetail>(`order-centers/lines/${order.id}`);
      return centerApi<OrderWorkDetail>(`order-centers/lines/${order.id}/actions`, { action, expectedRevision: detail.line.revision,
        expectedProjectionVersion: detail.line.projectionVersion, expectedEditorVersionId: project.version.id,
        idempotencyKey: randomUUID(), reason: "Synthetic operator requests a correction" });
    };
    await act("submit_artwork");
    expect((await act("reject_artwork")).line.artwork).toBe("changes_requested");
    project.version.document.name = "Synthetic operator correction revision";
    const oldAssetIds = project.version.document.layers.filter(layer => layer.kind === "image").map(layer => layer.assetId);
    project = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${project.project.id}/versions`, { expectedVersionId: project.version.id, document: project.version.document });
    expect(project.version.id).not.toBe(reviewedVersion); expect(project.version.reviewed).toBe(false);
    expect(project.version.document.layers.filter(layer => layer.kind === "image").map(layer => layer.assetId)).toEqual(oldAssetIds);
    expect((await act("submit_artwork")).line.artwork).toBe("in_review"); expect(modelCalls).toBe(2);
    expect((await centerApi<OrderWorkDetail>(`order-centers/lines/${order.id}`)).line.production).toBe("not_released");
    await page.reload();
    await openOrder(page, "/order-artwork", order.externalId);
    await expect(page.getByRole("region", { name: "无人设计进度" })).toContainText("人工核实并导入原结果");
    await page.screenshot({ path: testInfo.outputPath("pillow-response-recovered-review-mobile.png"), fullPage: true });
  } finally { worker?.kill(); }
});

test("expired private order responses retain exact fee evidence without restoring artwork or buying the model again",async({page},testInfo)=>{
  test.setTimeout(240_000);
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  const suffix=createEntityId().slice(-8),channelName=`Synthetic expiry cost ${suffix}`;
  const configuration=await centerApi<ConfigurationSnapshot>("ai/configuration",{operation:"channel.save",name:channelName,baseUrl:"https://synthetic.invalid/v1",apiKey:"synthetic-never-used",models:[{name:"gpt-image-2.5",capability:"image",label:`Expiry image ${suffix}`}]});
  const model=configuration.channels.find(channel=>channel.name===channelName)!.models[0]!;
  const profile=await createCenterProfile("shaped_pillow",`EXPIRY-${suffix}`,false,recipe);
  let template=await centerApi<ProductionEditorDetailView>(`production-editor/projects/${profile.projectId}`);
  if(template.version.document.productType!=="shaped_pillow")throw new Error("Wrong synthetic product");
  const document=applyPillowFactoryStandard(template.version.document);document.confirmations.physicalSize=true;
  document.automation={schemaVersion:1,workflow:"pillow_photo",imagePolicy:"faithful_enhancement",modelRouteId:model.id,allowOrderImageTransfer:true,modelCallLimit:2,estimatedCostPerCallUsd:0.1,maxEstimatedCostUsd:0.2};
  template=await centerApi<ProductionEditorDetailView>(`production-editor/projects/${profile.projectId}/versions`,{expectedVersionId:template.version.id,document});
  template=await centerApi<ProductionEditorDetailView>(`production-editor/projects/${profile.projectId}/review`,{expectedVersionId:template.version.id});
  const profiles=await centerApi<PrintProfileView[]>("order-centers/profiles",{code:profile.code,name:profile.name,projectId:profile.projectId,versionId:template.version.id,instructions:"Synthetic private-retention cost fixture",expectedVersion:profile.versionNumber,idempotencyKey:randomUUID()});
  const order=await preparePillowOrder(profiles.find(row=>row.id===profile.id)!.versionId,suffix);
  let worker:ChildProcess|undefined,modelCalls=0,access:Awaited<ReturnType<typeof workflowOperatorFixture>>|undefined;
  try{
    await openOrder(page,"/orders",order.externalId);await page.getByRole("button",{name:"推送本件设计",exact:true}).click();await waitRun(order.id);
    worker=await startProductionEditorWorker({fault:"expire_order_before_response",onModelCall:()=>{modelCalls++;}});
    await expect.poll(async()=>(await runView(order.id))?.errorCode,{timeout:90_000}).toBe("agent_source_expired");
    for(const query of ["view=unknown","view=financial&view=full","view=financial&tenantId=chosen"]){const invalid=await apiFetch(`${process.env.API_BASE_URL}/v1/order-centers/lines/${order.id}/design-agent?${query}`);expect(invalid.status).toBe(400);}
    for(const action of ["resume","takeover","restore-response"]){const invalid=await apiFetch(`${process.env.API_BASE_URL}/v1/order-centers/lines/${order.id}/design-agent/${action}?view=financial`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"});expect(invalid.status).toBe(400);}
    const run=(await runView(order.id))!;
    expect(run).toMatchObject({privateEvidenceState:"expired",methodSnapshot:null,completion:null,canResume:false,canTakeOver:false,costStatus:"reported",actualCostUsd:0.00000001});
    expect(run.modelCalls).toHaveLength(1);expect(run.modelCalls![0]).toMatchObject({costReportState:"reported",reportedCostUsd:"0.00000001",budgetAmountUsd:"0.000001",budgetState:"committed"});
    expect(JSON.stringify(run.modelCalls)).not.toMatch(/claimToken|encrypted|objectKey|prompt|checksum/);
    await openOrder(page,"/order-artwork",order.externalId);
    const panel=page.getByRole("region",{name:"无人设计进度"}),costs=panel.getByLabel("原调用费用依据",{exact:true});
    await expect(panel.getByText("订单私有资料已到期 历史方法和产物交接不再展示",{exact:true})).toBeVisible();
    await expect(panel.getByRole("region",{name:"本次固定的方法"})).toHaveCount(0);
    await costs.locator("summary").click();await expect(costs).toContainText("0.00000001 USD");await expect(costs).toContainText("0.000001 USD");
    await expect(panel.getByRole("button",{name:"从未完成步骤恢复"})).toHaveCount(0);await expect(panel.getByRole("button",{name:"停止自动制作并接管"})).toHaveCount(0);
    await costs.screenshot({path:testInfo.outputPath("expired-order-cost-desktop.png")});
    await page.setViewportSize({width:390,height:844});await costs.scrollIntoViewIfNeeded();expect(await costs.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
    await costs.screenshot({path:testInfo.outputPath("expired-order-cost-mobile.png")});
    await page.reload();await openOrder(page,"/order-artwork",order.externalId);
    await expect(page.getByRole("region",{name:"无人设计进度"})).toContainText("资料已到期");
    expect((await runView(order.id))?.modelCalls).toEqual(run.modelCalls);expect(modelCalls).toBe(1);
    const unavailable=await apiFetch(`${process.env.API_BASE_URL}/v1/production-editor/projects/${run.projectId}`);expect(unavailable.status).toBe(404);
    access=await workflowOperatorFixture();await assertCompletedOrderRevocation(page,order.id,access,Permission.OrderPiiRead);expect(errors).toEqual([]);
  }finally{worker?.kill();await access?.close();}
});

async function preparePillowOrder(profileVersionId: string, suffix: string) {
  const { artwork } = await centerApi<{ artwork: { versionId: string } }>("product-development/artworks", {
    code: `PILLOW-ART-${suffix}`, name: "Synthetic custom pillow", mode: "customer_image", expectedVersion: 0, idempotencyKey: randomUUID(),
    customization: { version: 1, fields: [
      { key: "buyer_photo", label: "Buyer photo", type: "image", required: true, validation: { allowedMediaTypes: ["image/png"], maxFiles: 1, maxBytes: 1_000_000 } },
      { key: "crop_scope", label: "Crop scope", type: "short_text", required: true },
      { key: "print_sides", label: "Print sides", type: "single_choice", required: true, options: [{ label: "Single sided", value: "single_sided" }, { label: "Double sided", value: "double_sided" }] },
    ] }, layout: [], instructions: "Synthetic fixture only; head crop with single-sided printing",
  });
  const spu = await createCenterSpu(`PILLOW-SPU-${suffix}`);
  const { specification } = await centerApi<{ specification: { versionId: string } }>("product-development/specifications", {
    spuId: spu.id, code: "10IN", name: "Synthetic 10 inch pillow", attributes: { size: "10 inch" },
    facts: syntheticSpecificationFacts({ material: "Synthetic fabric", dimensions: "10 inch longest visible subject", packageContents: "One pillow", packageQuantity: 1, factsConfirmed: true }),
    processProfileVersionId: profileVersionId, expectedVersion: 0, idempotencyKey: randomUUID(),
  });
  const order = await importOrder(suffix);
  const initial = await centerApi<OrderWorkDetail>(`order-centers/lines/${order.id}`);
  await centerApi(`order-centers/lines/${order.id}/draft`, { expectedRevision: initial.line.revision,
    expectedProjectionVersion: initial.line.projectionVersion, expectedSourceVersionId: initial.report?.versionId ?? null,
    status: "pending_review", reason: "Initialize encrypted synthetic work before uploading its original", idempotencyKey: randomUUID(),
    draft: { ...initial.draft, salesRecipeVersionId: null, salesPackageId: null, artworkVersionId: artwork.versionId,
      specificationVersionId: specification.versionId, printProfileVersionId: profileVersionId, designExecutor: "agent", images: [] } });
  const detail = await centerApi<OrderWorkDetail>(`order-centers/lines/${order.id}/images`, { name: "synthetic-buyer.png", contentBase64: syntheticProductionPng(512).toString("base64") });
  const original = detail.assets.find(asset => asset.name === "synthetic-buyer.png")!;
  expect(original).toBeTruthy();
  await centerApi(`order-centers/lines/${order.id}/draft`, { expectedRevision: detail.line.revision, expectedProjectionVersion: detail.line.projectionVersion,
    expectedSourceVersionId: detail.report?.versionId ?? null, status: "ready_to_push", reason: "Synthetic pillow order reviewed", idempotencyKey: randomUUID(),
    draft: { ...detail.draft, salesRecipeVersionId: null, salesPackageId: null, artworkVersionId: artwork.versionId, specificationVersionId: specification.versionId,
      printProfileVersionId: profileVersionId, designExecutor: "agent", instructions: "", fields: [
        { key: "crop_scope", label: "Crop scope", kind: "text", value: "head" }, { key: "print_sides", label: "Print sides", kind: "choice", value: "single_sided" },
      ], images: [{ origin: "upload", key: original.id, usage: "buyer_photo" }] } });
  return order;
}

async function publishOrderMethod(notes:string){
  const methodKey="order.design.template",read=async()=>(await centerApi<AgentMethodWorkspace>("agent-methods/workspace")).methods.find(row=>row.methodKey===methodKey);
  const previous=await read();await centerApi("agent-methods/save",{methodKey,expectedRevision:previous?.revision??0,notes,knowledgeVersionIds:[],reason:"Synthetic order method review",requestId:randomUUID()});
  for(const action of ["submit","publish"] as const){const row=(await read())!;await centerApi(`agent-methods/${row.id}/${action}`,{expectedRevision:row.revision,version:row.latestVersion,reason:"Synthetic explicit publication",requestId:randomUUID(),...(action==="publish"?{reviewedChecksum:row.latest.checksum}:{})});}
  return (await read())!;
}
async function assertCompletedOrderRevocation(page:Page,id:string,access:Awaited<ReturnType<typeof workflowOperatorFixture>>,revokedPermission:string=Permission.WorkflowRead){
  const path=`**/api/order-centers/lines/${id}/design-agent**`,panel=page.getByRole("region",{name:"无人设计进度"});
  let releaseLate=()=>{},markFetched=()=>{},markDrained=()=>{},held=false;
  const release=new Promise<void>(resolve=>{releaseLate=resolve;}),fetched=new Promise<void>(resolve=>{markFetched=resolve;}),drained=new Promise<void>(resolve=>{markDrained=resolve;});
  const handler:Parameters<Page["route"]>[1]=async route=>{
    if(route.request().method()!=="GET"){await route.continue();return;}
    const response=await route.fetch(),hold=response.status()===200&&!held;
    if(hold){held=true;markFetched();await release;}
    await route.fulfill({response}).catch(()=>{});if(hold)markDrained();
  };
  await page.route(path,handler);
  try{
    await page.evaluate(()=>window.dispatchEvent(new Event("focus")));await fetched;
    await access.permissions(Object.values(Permission).filter(value=>value!==revokedPermission));
    expect((await page.request.get(`/api/order-centers/lines/${id}/design-agent`)).status()).toBe(403);
    await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
    await expect(panel.getByRole("region",{name:"本次固定的方法"})).toHaveCount(0);await expect(panel.getByLabel("原始制作交接")).toHaveCount(0);
    await expect(panel.getByLabel("原调用费用依据")).toHaveCount(0);
    releaseLate();await drained;
    await expect(panel.getByRole("region",{name:"本次固定的方法"})).toHaveCount(0);await expect(panel.getByLabel("原始制作交接")).toHaveCount(0);
    await expect(panel.getByLabel("原调用费用依据")).toHaveCount(0);
    await expect(panel.getByRole("alert")).toContainText("当前状态尚未核对");
  }finally{releaseLate();await access.permissions();await page.unroute(path,handler);}
}
async function runView(id: string) { return (await centerApi<{ run: DesignAgentRunView | null }>(`order-centers/lines/${id}/design-agent`)).run; }
async function waitRun(id: string) { await expect.poll(async () => !!await runView(id)).toBe(true); return (await runView(id))!; }
async function openOrder(page: Page, path: string, externalId: string) {
  await page.goto(`${path}?q=${externalId}`);
  await page.getByRole("button", { name: externalId, exact: true }).click();
  const drawer=page.getByRole("dialog",{name:"整单详情",exact:true});
  await drawer.getByRole("button",{name:path==="/orders"?"订单要求":"审核与制图",exact:true}).click();
}
async function prepareOrder(recipeId: string, suffix: string) {
  const { id, externalId } = await importOrder(suffix);
  const detail = await centerApi<OrderWorkDetail>(`order-centers/lines/${id}`);
  const selected = detail.catalog!.recipes.find(candidate => candidate.id === recipeId)!;
  expect(selected).toBeTruthy();
  await centerApi(`order-centers/lines/${id}/draft`, { expectedRevision: detail.line.revision, expectedProjectionVersion: detail.line.projectionVersion,
    expectedSourceVersionId: detail.report?.versionId ?? null, status: "ready_to_push", reason: "Reviewed synthetic automated recipe", idempotencyKey: randomUUID(),
    draft: { ...detail.draft, salesRecipeVersionId: selected.id, salesPackageId: null, artworkVersionId: selected.artworkVersionId,
      specificationVersionId: selected.specificationVersionId, printProfileVersionId: selected.processProfileVersionId, designExecutor: "agent", instructions: "", fields: [], images: [] } });
  return { id, externalId };
}
async function importOrder(suffix: string) {
  const externalId = `E2E-AGENT-${suffix}`;
  const account = await centerApi<MarketplaceAccountView>("marketplace-accounts", { platform: "amazon", displayName: externalId, region: "NA", marketplaceIds: ["ATVPDKIKX0DER"], authorizationMode: "amazon_private", requestedScopes: [] });
  const batch = await centerApi<AmazonReportBatchView>("orders/reports/import", { accountId: account.id, marketplaceId: "ATVPDKIKX0DER", fileName: "synthetic-agent.txt",
    content: `order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\n${externalId}\tITEM-${suffix}\t${new Date().toISOString()}\tAGENT-SKU-${suffix}\tSynthetic agent order\t1\tUSD\t20.00` });
  const imported = await centerApi<AmazonReportWorkspaceView>(`orders/reports/workspace?batchId=${batch.id}`);
  const id = imported.lines[0]!.orderLineId;
  return { id, externalId };
}
