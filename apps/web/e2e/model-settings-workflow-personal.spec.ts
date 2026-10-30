import { expect, test, type Page } from "@playwright/test";
import { ConfigurationRpcSchema, ConfigurationSnapshotSchema, emptyModelDefaults, type ConfigurationRpc, type ConfigurationSnapshot, type ConfiguredChannelModel } from "@yummyai/contracts/ai/model-configuration";
import { ModelBillingWorkspaceSchema } from "@yummyai/contracts/ai/model-billing";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { requireStudioPersonalEnvironment } from "../../../tools/testing/require-studio-personal-environment.mjs";
import { loginErp } from "./erp-identity-fixture.js";

requireStudioPersonalEnvironment(process.env, true);
if (process.env.E2E_STUDIO_CONFIGURATION_ISOLATED !== "1")
  throw new Error("Native model settings require the isolated compiled personal configuration runner");

const id = (suffix: number) => `019f4000-0000-7000-8000-${suffix.toString(16).padStart(12, "0")}`;
const channelId = id(1), firstId = id(2), secondId = id(3), imageId = id(4), legacyId = id(5), pausedId = id(6);
const channelName = "Synthetic team provider";
const labels = { first: "Synthetic inherited text", second: "Synthetic capped text", image: "Synthetic image", legacy: "Synthetic legacy analysis" };
const quote = { inputUsdPerMillion: 3, outputUsdPerMillion: 7, maxTaskCostUsd: 4 };
function initialSnapshot(): ConfigurationSnapshot {
  return ConfigurationSnapshotSchema.parse({ channels: [{ id: channelId, name: channelName, baseUrl: "https://synthetic-models.example.test/v1", provider: "openai", textProtocol: "responses",
    hasCredential: true, status: "enabled", revision: "a".repeat(64), dependentRoutes: [],
    analysisModels: [{ id: legacyId, name: "looks-image-but-text", label: labels.legacy, analysisPricing: quote }],
    models: [
      { id: firstId, name: "looks-image-but-text", label: labels.first, capability: "text", analysisPricing: quote, analysisPricingInheritedFrom: legacyId },
      { id: secondId, name: "synthetic-text-2", label: labels.second, capability: "text", analysisPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxTaskCostUsd: 1 } },
      { id: imageId, name: "synthetic-image-1", label: labels.image, capability: "image" },
      { id: pausedId, name: "paused-text", label: "Synthetic paused model", capability: "text", status: "disabled" },
    ] }], analysisModels: [
    { id: firstId, label: labels.first, model: "looks-image-but-text", providerLabel: channelName, providerConfigId: channelId },
    { id: secondId, label: labels.second, model: "synthetic-text-2", providerLabel: channelName, providerConfigId: channelId },
    { id: legacyId, label: labels.legacy, model: "looks-image-but-text", providerLabel: channelName, providerConfigId: channelId },
  ], defaults: { ...emptyModelDefaults(), text: secondId, purposeDefaults: { knowledge_answer: firstId } }, defaultsRevision: 7 });
}
async function fixture(page: Page, returnTo = "/settings/ai") {
  const state = { snapshot: initialSnapshot(), commands: [] as ConfigurationRpc[], externalCalls: [] as string[], paidRequests: [] as string[], billingReads: 0,
    unknownSave: null as "unchanged" | "saved" | null, holdSave: false, releaseSave: null as (() => void) | null, revision: 11, nextModel: 100 };
  const revision = () => (++state.revision).toString(16).padStart(64, "0");
  const refreshAnalysis = () => {
    state.snapshot.analysisModels = state.snapshot.channels.filter(channel => channel.status === "enabled").flatMap(channel => [
      ...channel.models.filter(model => model.capability === "text" && model.status !== "disabled"),
      ...channel.analysisModels.filter(model => model.status !== "disabled"),
    ].map(model => ({ id: model.id, label: model.label, model: model.name, providerLabel: channel.name, providerConfigId: channel.id })));
  };
  // Only configuration, assist catalogue and billing DTOs are synthetic. Login,
  // the personal session, authority headers and compiled rendering remain real.
  await page.route("https://synthetic-models.example.test/**", async route => { state.externalCalls.push(route.request().url()); await route.abort(); });
  await page.route("https://api.openai.com/**", async route => { state.externalCalls.push(route.request().url()); await route.abort(); });
  await page.route("**/api/creative-studio/configuration", async route => {
    const input = ConfigurationRpcSchema.parse(route.request().postDataJSON()); state.commands.push(input);
    const authority = route.request().headers()["x-yummyai-context-authority"];
    const headers: Record<string, string> = authority ? { "x-yummyai-context-authority": authority } : {};
    const reply = async (json: unknown, status = 201) => route.fulfill({ status, headers, json });
    if (input.operation === "channel.discover") {
      await reply({ source: "provider", fetchedAt: "2026-10-30T00:00:00Z", skipped: 0,
        models: ["looks-image-but-text", "synthetic-text-2", "catalogue-new-2", "catalogue-new-10"] }); return;
    }
    if (input.operation === "channel.save") {
      if (state.holdSave) await new Promise<void>(resolve => { state.releaseSave = resolve; });
      if (state.unknownSave === "unchanged") { await reply({ error: "PRIVATE_NATIVE_SAVE_DIAGNOSTIC" }, 502); return; }
      const existing = state.snapshot.channels.find(channel => channel.id === input.id);
      const models: ConfiguredChannelModel[] = input.models.map(model => {
        const prior = existing?.models.find(item => item.id === model.id || !model.id && item.name === model.name);
        return { ...prior, ...model, id: model.id ?? prior?.id ?? id(state.nextModel++), label: model.label ?? model.name };
      });
      const saved = { ...(existing ?? { id: id(state.nextModel++), provider: "openai", hasCredential: true, status: "enabled" as const, dependentRoutes: [], analysisModels: [] }),
        name: input.name, baseUrl: input.baseUrl, models, revision: revision(), textProtocol: input.textProtocol ?? existing?.textProtocol };
      state.snapshot.channels = existing ? state.snapshot.channels.map(channel => channel.id === existing.id ? saved : channel) : [...state.snapshot.channels, saved];
      refreshAnalysis();
      if (state.unknownSave === "saved") { await reply({ error: "PRIVATE_NATIVE_LOST_ACK" }, 502); return; }
    } else if (input.operation === "purpose-defaults.save") {
      state.snapshot.defaults = { ...state.snapshot.defaults, purposeDefaults: { ...state.snapshot.defaults.purposeDefaults, ...input.defaults } }; state.snapshot.defaultsRevision++;
    } else if (input.operation === "defaults.save") {
      state.snapshot.defaults = { ...input.defaults, purposeDefaults: input.defaults.purposeDefaults ?? state.snapshot.defaults.purposeDefaults }; state.snapshot.defaultsRevision++;
    } else if (input.operation === "model.analysis-pricing.save") {
      const channel = state.snapshot.channels.find(item => item.id === input.channelId)!;
      const target = [...channel.models, ...channel.analysisModels].find(item => item.id === input.modelId)!;
      if ("analysisPricingInheritedFrom" in target && target.analysisPricingInheritedFrom) {
        await reply({ code: "model_configuration_pricing_conflict", error: "PRIVATE_PRICING_DIAGNOSTIC" }, 409); return;
      }
      target.analysisPricing = input.pricing; channel.revision = revision();
    } else if (input.operation === "model.status") {
      const channel = state.snapshot.channels.find(item => item.id === input.channelId)!;
      [...channel.models, ...channel.analysisModels].find(item => item.id === input.modelId)!.status = input.status;
      channel.revision = revision(); refreshAnalysis();
    } else if (input.operation === "model.update") {
      const channel = state.snapshot.channels.find(item => item.id === input.channelId)!;
      [...channel.models, ...channel.analysisModels].find(item => item.id === input.modelId)!.label = input.label;
      channel.revision = revision(); refreshAnalysis();
    }
    await reply(ConfigurationSnapshotSchema.parse(state.snapshot));
  });
  await page.route("**/api/ai-assists/models**", async route => {
    const authority = route.request().headers()["x-yummyai-context-authority"];
    const headers: Record<string, string> = authority ? { "x-yummyai-context-authority": authority } : {};
    await route.fulfill({ headers, json: state.snapshot.analysisModels.map(model => {
      const source = state.snapshot.channels.flatMap(channel => [...channel.models, ...channel.analysisModels]).find(item => item.id === model.id)!;
      return { ...model, providerConfigId: undefined, ...(source.analysisPricing ?? { inputUsdPerMillion: null, outputUsdPerMillion: null, maxTaskCostUsd: null }) };
    }) });
  });
  await page.route("**/api/model-billing/workspace**", async route => {
    state.billingReads++; await route.fulfill({ json: ModelBillingWorkspaceSchema.parse({ nextCursor: null, items: [] }) });
  });
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (/\/api\/(?:ai-assists\/runs|creative-studio\/generations|agent-chat)/).test(path)) state.paidRequests.push(path);
  });
  page.on("dialog", async dialog => { await dialog.accept(); });
  await loginErp(page, "operator", returnTo);
  const workbench = page.getByRole("region", { name: "统一模型配置", exact: true });
  await expect(workbench).toContainText(channelName);
  return { state, workbench };
}
async function openPricing(page: Page, label: string) {
  const workbench = page.getByRole("region", { name: "统一模型配置", exact: true });
  await workbench.getByRole("tab", { name: "模型库", exact: true }).click();
  await workbench.getByLabel("搜索模型或渠道", { exact: true }).fill(label);
  await workbench.getByLabel(`更多模型操作 ${label}`, { exact: true }).click();
  await workbench.getByRole("button", { name: "价格与费用策略", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `价格与费用策略 · ${label}`, exact: true });
  await expect(dialog).toBeVisible(); return dialog;
}

test("native personal settings discover and batch-select models with a manual fallback while retaining saved credentials", async ({ page }, testInfo) => {
  const { state, workbench } = await fixture(page);
  try {
    await expect(workbench.getByRole("tab")).toHaveCount(4);
    await expect(page.locator('iframe[title="无限画布模型配置"]')).toHaveCount(0);
    const original = structuredClone(state.snapshot.channels[0]!.models);
    await workbench.getByRole("button", { name: `编辑渠道 ${channelName}`, exact: true }).click();
    const editor = page.getByRole("dialog", { name: `编辑渠道 · ${channelName}`, exact: true });
    await expect(editor.getByLabel(/^API Key/)).toHaveValue("");
    await editor.getByRole("button", { name: "获取模型目录", exact: true }).click();
    await editor.getByLabel("搜索目录模型", { exact: true }).fill("catalogue-new");
    await editor.getByRole("button", { name: "选择当前筛选模型", exact: true }).click();
    await editor.getByText("高级 · 手动添加模型", { exact: true }).click();
    const manual = editor.locator("details").filter({ has: page.locator("summary").filter({ hasText: /^高级 · 手动添加模型$/ }) });
    await expect(manual).toHaveCount(1);
    await manual.getByRole("textbox", { name: "model ID", exact: true }).fill("manual-custom-image");
    await manual.getByRole("combobox", { name: "配置用途", exact: true }).selectOption("image");
    await expect(manual.getByRole("combobox", { name: "配置用途", exact: true })).toHaveValue("image");
    await manual.getByRole("button", { name: "手动添加模型", exact: true }).click();
    await expect(editor.getByRole("region", { name: "已选渠道模型", exact: true })).toContainText("已选模型 7");
    await expect(editor.getByRole("region", { name: "已选渠道模型", exact: true }).getByRole("combobox", { name: "manual-custom-image 配置用途", exact: true })).toHaveValue("image");
    await expect(editor).toContainText("能力未实测");
    await page.screenshot({ path: testInfo.outputPath("native-channel-desktop.png") });
    await editor.getByRole("button", { name: "保存渠道与模型", exact: true }).click();
    await expect(editor).toBeHidden();
    const save = state.commands.find((input): input is Extract<ConfigurationRpc, { operation: "channel.save" }> => input.operation === "channel.save")!;
    expect(save).not.toHaveProperty("apiKey");
    expect(save.models).toHaveLength(7);
    expect(save.models.find(model => model.name === "catalogue-new-2")?.capability).toBe("text");
    expect(save.models.find(model => model.name === "manual-custom-image")?.capability).toBe("image");
    expect(state.snapshot.channels[0]!.models.find(model => model.id === firstId)).toEqual(original.find(model => model.id === firstId));
    expect(state.snapshot.channels[0]!.models.find(model => model.id === pausedId)?.status).toBe("disabled");
    expect(state.commands.find(input => input.operation === "channel.discover")).toEqual({ operation: "channel.discover", id: channelId, baseUrl: "https://synthetic-models.example.test/v1" });
    expect(state.externalCalls).toEqual([]); expect(state.paidRequests).toEqual([]);
  } finally { state.releaseSave?.(); await page.unrouteAll({ behavior: "wait" }); }
});

test("personal business defaults retain other purposes and survive a deep-link reload without losing return context", async ({ page }, testInfo) => {
  const returnTarget = `/orders?${new URLSearchParams({ line: id(21), queue: id(21) })}`;
  const { state, workbench } = await fixture(page, `/settings/ai?${new URLSearchParams({ returnTo: returnTarget, settingsTab: "defaults" })}`);
  try {
    await expect(workbench.getByRole("tab", { name: "业务默认", exact: true })).toHaveAttribute("aria-selected", "true");
    await workbench.getByLabel(/^订单定制信息解析/).selectOption(firstId);
    await workbench.getByLabel(/^生产稿 AI 预检/).selectOption(secondId);
    await workbench.getByLabel(/^AI Agent 对话/).selectOption(secondId);
    await workbench.getByRole("button", { name: "保存业务用途默认", exact: true }).click();
    const saved = state.commands.find((input): input is Extract<ConfigurationRpc, { operation: "purpose-defaults.save" }> => input.operation === "purpose-defaults.save")!;
    expect(saved).toEqual({ operation: "purpose-defaults.save", revision: 7, defaults: { knowledge_answer: firstId, order_review: firstId, artwork_preflight: secondId, agent_chat: secondId } });
    await workbench.getByLabel(/^图片生成与无人设计/).selectOption(imageId);
    await workbench.getByRole("button", { name: "保存通用默认", exact: true }).click();
    expect(state.snapshot.defaults.image).toBe(imageId);
    expect(state.snapshot.defaults.purposeDefaults?.knowledge_answer).toBe(firstId);
    await expect(workbench).toContainText("原任务 工艺底稿和固定版本继续使用其已绑定模型");
    await page.screenshot({ path: testInfo.outputPath("native-business-defaults-desktop.png") });
    await workbench.getByRole("tab", { name: "模型库", exact: true }).click();
    expect(new URL(page.url()).searchParams.get("returnTo")).toBe(returnTarget);
    expect(new URL(page.url()).searchParams.get("settingsTab")).toBe("models");
    await page.reload();
    await expect(workbench.getByRole("tab", { name: "模型库", exact: true })).toHaveAttribute("aria-selected", "true");
    await workbench.getByRole("tab", { name: "业务默认", exact: true }).click();
    await expect(workbench.getByLabel(/^订单定制信息解析/)).toHaveValue(firstId);
    await expect(workbench.getByLabel(/^AI Agent 对话/)).toHaveValue(secondId);
    expect(state.externalCalls).toEqual([]); expect(state.paidRequests).toEqual([]);
  } finally { state.releaseSave?.(); await page.unrouteAll({ behavior: "wait" }); }
});

test("native fee strategy keeps unknown quotes null, removes a cap explicitly and opens the inherited quote source", async ({ page }, testInfo) => {
  const { state } = await fixture(page);
  try {
    let dialog = await openPricing(page, labels.second);
    await expect(dialog.getByRole("radio", { name: /^设置单次费用上限/ })).toBeChecked();
    await expect(dialog.getByLabel("单次费用上限（美元）", { exact: true })).toHaveValue("1");
    await dialog.getByRole("radio", { name: /^不限额 记录真实用量/ }).check();
    await dialog.getByText("高级 · 渠道估算报价", { exact: true }).click();
    await dialog.getByLabel("输入单价（美元/百万 tokens）", { exact: true }).fill("");
    await dialog.getByLabel("输出单价（美元/百万 tokens）", { exact: true }).fill("");
    await expect(dialog).toContainText("待核价");
    await page.screenshot({ path: testInfo.outputPath("native-unlimited-unknown-quote.png") });
    await dialog.getByRole("button", { name: "保存费用策略", exact: true }).click();
    await expect(dialog).toBeHidden();
    const saved = state.commands.find((input): input is Extract<ConfigurationRpc, { operation: "model.analysis-pricing.save" }> => input.operation === "model.analysis-pricing.save")!;
    expect(saved).toMatchObject({ channelId, modelId: secondId, pricing: { inputUsdPerMillion: null, outputUsdPerMillion: null, maxTaskCostUsd: null } });
    expect(state.snapshot.channels[0]!.models.find(model => model.id === firstId)?.analysisPricing).toEqual(quote);
    dialog = await openPricing(page, labels.first);
    await expect(dialog).toContainText("继承自关联分析配置");
    await expect(dialog.getByLabel("单次费用上限（美元）", { exact: true })).toHaveValue("4");
    await dialog.getByRole("button", { name: "核对关联分析模型", exact: true }).click();
    const related = page.getByRole("dialog", { name: `价格与费用策略 · ${labels.legacy}`, exact: true });
    await expect(related).toBeVisible();
    await expect(related.getByLabel("单次费用上限（美元）", { exact: true })).toHaveValue("4");
    await related.getByRole("button", { name: "取消", exact: true }).click();
    await expect(related).toBeHidden();
    expect(state.commands.filter(input => input.operation === "model.analysis-pricing.save")).toHaveLength(1);
    expect(state.externalCalls).toEqual([]); expect(state.paidRequests).toEqual([]);
  } finally { state.releaseSave?.(); await page.unrouteAll({ behavior: "wait" }); }
});

test("native unknown writes retain drafts and remain blocked across dialog reopening until a configuration read", async ({ page }, testInfo) => {
  const { state, workbench } = await fixture(page);
  try {
    state.unknownSave = "unchanged";
    await workbench.getByRole("button", { name: `编辑渠道 ${channelName}`, exact: true }).click();
    let editor = page.getByRole("dialog", { name: `编辑渠道 · ${channelName}`, exact: true });
    await editor.getByLabel("渠道名称", { exact: true }).fill("Synthetic unsaved rename");
    await editor.getByRole("button", { name: "保存渠道与模型", exact: true }).click();
    await expect(editor).toContainText("配置结果尚未核对");
    await expect(editor).not.toContainText("PRIVATE_NATIVE_SAVE_DIAGNOSTIC");
    await expect(editor.getByLabel("渠道名称", { exact: true })).toHaveValue("Synthetic unsaved rename");
    await expect(editor.getByRole("button", { name: "保存渠道与模型", exact: true })).toBeDisabled();
    expect(state.commands.filter(input => input.operation === "channel.save")).toHaveLength(1);
    await editor.getByRole("button", { name: "取消", exact: true }).click();
    await expect(editor).toBeHidden();
    await workbench.getByRole("button", { name: `编辑渠道 ${channelName}`, exact: true }).click();
    editor = page.getByRole("dialog", { name: `编辑渠道 · ${channelName}`, exact: true });
    await expect(editor.getByRole("button", { name: "保存渠道与模型", exact: true })).toBeDisabled();
    state.unknownSave = null;
    await editor.getByRole("button", { name: "读取原配置核对", exact: true }).click();
    expect(state.commands.filter(input => input.operation === "channel.save")).toHaveLength(1);
    await editor.getByLabel("渠道名称", { exact: true }).fill("Synthetic rename after readback");
    await editor.getByRole("button", { name: "保存渠道与模型", exact: true }).click();
    await expect(editor).toBeHidden();
    expect(state.commands.filter(input => input.operation === "channel.save")).toHaveLength(2);
    await expect(workbench).toContainText("Synthetic rename after readback");
    await page.screenshot({ path: testInfo.outputPath("native-readback-recovery.png") });
    expect(state.externalCalls).toEqual([]); expect(state.paidRequests).toEqual([]);
  } finally { state.releaseSave?.(); await page.unrouteAll({ behavior: "wait" }); }
});

test("native session invalidation removes private editing state and ignores a late saved acknowledgement", async ({ page }) => {
  const { state, workbench } = await fixture(page);
  try {
    state.holdSave = true;
    await workbench.getByRole("button", { name: `编辑渠道 ${channelName}`, exact: true }).click();
    const editor = page.getByRole("dialog", { name: `编辑渠道 · ${channelName}`, exact: true });
    await editor.getByLabel("渠道名称", { exact: true }).fill("Synthetic late private draft");
    await editor.getByRole("button", { name: "保存渠道与模型", exact: true }).click();
    await expect.poll(() => state.commands.filter(input => input.operation === "channel.save").length).toBe(1);
    await expect.poll(() => state.releaseSave !== null).toBe(true);
    await page.evaluate(event => window.dispatchEvent(new Event(event)), ASSIST_INTENT_CLEAR_EVENT);
    await expect(editor).toBeHidden();
    await expect(page.locator(".ai-settings-workbench input,.ai-settings-workbench select")).toHaveCount(0);
    state.releaseSave!();
    await expect(page.getByRole("status").filter({ hasText: /配置.*填写.*隐藏/ })).toBeVisible();
    await expect(page.getByText("Synthetic late private draft", { exact: true })).toHaveCount(0);
    expect(state.commands.filter(input => input.operation === "channel.save")).toHaveLength(1);
    expect(state.externalCalls).toEqual([]); expect(state.paidRequests).toEqual([]);
  } finally { state.releaseSave?.(); await page.unrouteAll({ behavior: "wait" }); }
});

test("native settings stay readable at 390 pixels with accessible tabs and forty-four-pixel controls", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { state, workbench } = await fixture(page);
  try {
    const longName = "long-model-" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".repeat(3);
    const longLabel = "Synthetic 超长显示名称 " + "UnbrokenModelDisplayName".repeat(3);
    state.snapshot.channels[0]!.models.push({ id: id(80), name: longName, label: longLabel, capability: "text" });
    state.snapshot.analysisModels.push({ id: id(80), label: longLabel, model: longName, providerLabel: channelName, providerConfigId: channelId });
    await workbench.getByRole("button", { name: "刷新配置", exact: true }).click();
    for (const name of ["渠道连接", "模型库", "业务默认", "用量与费用"]) {
      const tab = workbench.getByRole("tab", { name, exact: true });
      const bounds = await tab.boundingBox(); expect(bounds).not.toBeNull();
      expect(bounds!.width).toBeGreaterThanOrEqual(44); expect(bounds!.height).toBeGreaterThanOrEqual(44);
      await tab.click(); await expect(tab).toHaveAttribute("aria-selected", "true");
    }
    await workbench.getByRole("tab", { name: "模型库", exact: true }).click();
    const search = workbench.getByLabel("搜索模型或渠道", { exact: true });
    await search.fill("long-model-");
    const inputBounds = await search.boundingBox(); expect(inputBounds!.height).toBeGreaterThanOrEqual(44);
    await expect(workbench).toContainText(longLabel);
    await expect(workbench).toContainText("文本任务（配置用途）");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("native-settings-mobile.png") });
    await workbench.getByRole("tab", { name: "渠道连接", exact: true }).click();
    await workbench.getByRole("button", { name: "添加渠道", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "添加模型渠道", exact: true });
    const dialogBounds = await editor.boundingBox(); expect(dialogBounds!.width).toBeLessThanOrEqual(390);
    const field = editor.getByLabel("接口地址", { exact: true });
    const fieldBounds = await field.boundingBox(); expect(fieldBounds!.height).toBeGreaterThanOrEqual(44);
    await expect(editor.getByRole("button", { name: "保存渠道与模型", exact: true })).toBeDisabled();
    await expect(editor).toContainText("填写渠道名称");
    await page.screenshot({ path: testInfo.outputPath("native-channel-mobile.png") });
    await editor.getByRole("button", { name: "取消", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(state.billingReads).toBe(1);
    expect(state.externalCalls).toEqual([]); expect(state.paidRequests).toEqual([]);
  } finally { state.releaseSave?.(); await page.unrouteAll({ behavior: "wait" }); }
});
