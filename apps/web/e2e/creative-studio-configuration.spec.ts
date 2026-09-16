import { expect, test, type Page } from "@playwright/test";
import { emptyModelDefaults, type ConfigurationRpc, type ConfigurationSnapshot } from "@yummyai/contracts/ai/model-configuration";

const channelId = "019a0000-0000-7000-8000-000000000001";
const imageId = "019a0000-0000-7000-8000-000000000002";
const analysisId = "019a0000-0000-7000-8000-000000000003";
function snapshot(): ConfigurationSnapshot {
  return { channels: [{ id: channelId, name: "QA OpenAI", provider: "openai", baseUrl: "https://api.openai.com/v1", hasCredential: true, status: "enabled", revision: "a".repeat(64), analysisModels: [], dependentRoutes: [], models: [{ id: imageId, label: "QA Image", name: "gpt-image-fixture", capability: "image" }] }], analysisModels: [], defaults: emptyModelDefaults(), defaultsRevision: 0 };
}
async function fixture(page: Page) {
  const state = { snapshot: snapshot(), failSave: false, failDiscover: false, failRemove: false, holdRemoval: null as Promise<void> | null, requests: [] as ConfigurationRpc[], externalCalls: [] as string[] };
  // The actual ERP page and vendored runtime render; this fixture owns only the
  // configuration HTTP boundary. No live tenant configuration or provider is used.
  await page.route("https://api.openai.com/**", async route => { state.externalCalls.push(route.request().url()); await route.abort(); });
  await page.route("**/api/creative-studio/configuration", async route => {
    const input = route.request().postDataJSON() as ConfigurationRpc;
    state.requests.push(input);
    let result: unknown = state.snapshot;
    if (input.operation === "channel.discover") {
      if (state.failDiscover) { await route.fulfill({ status: 502, json: { error: "渠道不提供模型目录，请手动填写模型名称" } }); return; }
      result = { models: ["gpt-image-fixture", "gpt-text-fixture", "gpt-text-second"], fetchedAt: "2026-09-14T08:00:00Z", source: "provider", skipped: 0 };
    } else if (input.operation === "channel.save") {
      if (state.failSave) { await route.fulfill({ status: 409, json: { error: "渠道已被修改，请刷新配置后重试" } }); return; }
      state.snapshot.channels = [{ ...state.snapshot.channels[0]!, name: input.name, baseUrl: input.baseUrl, revision: "b".repeat(64), models: input.models.map((model, index) => ({ ...model, id: model.id ?? `019a0000-0000-7000-8000-${String(index + 10).padStart(12, "0")}`, label: model.label ?? model.name })) }];
    } else if (input.operation === "defaults.save") {
      state.snapshot.defaults = input.defaults; state.snapshot.defaultsRevision++;
    } else if (input.operation === "channel.remove") {
      if (state.holdRemoval) await state.holdRemoval;
      if (state.failRemove) { await route.fulfill({ status: 409, json: { error: "该渠道仍有排队或进行中的任务，请等待完成或取消任务后再删除" } }); return; }
      const removed = state.snapshot.channels.find(channel => channel.id === input.id)!;
      const ids = [...removed.models, ...removed.analysisModels].map(model => model.id);
      state.snapshot.channels = state.snapshot.channels.filter(channel => channel.id !== input.id);
      state.snapshot.analysisModels = state.snapshot.analysisModels.filter(model => model.providerConfigId !== input.id);
      for (const capability of ["image", "video", "text", "analysis"] as const) if (ids.includes(state.snapshot.defaults[capability] ?? "")) state.snapshot.defaults[capability] = null;
      state.snapshot.defaultsRevision++;
    } else if (input.operation === "channel.status") state.snapshot.channels[0]!.status = input.status;
    else if (input.operation === "model.remove") {
      if (state.holdRemoval) await state.holdRemoval;
      if (state.failRemove) { await route.fulfill({ status: 409, json: { error: "该模型仍有排队或进行中的任务，请等待完成或取消任务后再删除" } }); return; }
      const channel = state.snapshot.channels.find(item => item.id === input.channelId)!;
      channel.models = channel.models.filter(item => item.id !== input.modelId);
      channel.revision = "c".repeat(64);
      state.snapshot.analysisModels = state.snapshot.analysisModels.filter(item => item.id !== input.modelId);
      for (const capability of ["image", "video", "text", "analysis"] as const) if (state.snapshot.defaults[capability] === input.modelId) state.snapshot.defaults[capability] = null;
      state.snapshot.defaultsRevision++;
    }
    await route.fulfill({ status: 200, json: result });
  });
  await page.route("**/api/ai-assists/models", async route => {
    await route.fulfill({ json: state.snapshot.analysisModels.map(model => ({ ...model, inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxTaskCostUsd: 1 })) });
  });
  await page.goto("/settings/ai");
  const frame = page.frameLocator('iframe[title="无限画布模型配置"]');
  await expect(frame.getByRole("button", { name: "编辑渠道", exact: true })).toBeVisible({ timeout: 30_000 });
  return { frame, state };
}

test("upstream configuration discovers using saved credentials, selects models and retains a failed save", async ({ page }, testInfo) => {
  const { frame, state } = await fixture(page);
  await frame.getByRole("button", { name: "编辑渠道", exact: true }).click();
  const drawer = frame.getByRole("dialog", { name: "编辑渠道", exact: true });
  await expect(drawer.getByLabel("API Key", { exact: true })).toHaveValue("");
  await expect(drawer.getByLabel("API Key", { exact: true })).toHaveAttribute("placeholder", /留空保留原 Key/);
  await drawer.getByRole("button", { name: "选择模型", exact: true }).click();
  const modal = frame.getByRole("dialog", { name: /选择渠道模型/ });
  await modal.getByRole("button", { name: "拉取模型列表", exact: true }).click();
  await expect(modal.getByRole("checkbox", { name: "gpt-image-fixture", exact: true })).toBeChecked();
  await modal.getByPlaceholder("搜索模型", { exact: true }).fill("gpt-text");
  await modal.getByRole("button", { name: "全选当前列表", exact: true }).click();
  await modal.getByPlaceholder("输入模型名称", { exact: true }).fill("custom-image-manual");
  await modal.getByRole("button", { name: "增加模型", exact: true }).click();
  await modal.getByRole("button", { name: /^确\s*定$/ }).click();
  await expect(drawer).toContainText("已选择 4 个模型");
  expect(state.requests.find(request => request.operation === "channel.discover")).toEqual({ operation: "channel.discover", id: channelId, baseUrl: "https://api.openai.com/v1" });
  state.failSave = true;
  await drawer.getByRole("button", { name: "保存渠道", exact: true }).click();
  await expect(frame.getByText("渠道已被修改，请刷新配置后重试", { exact: true })).toBeVisible();
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("custom-image-manual");
  state.failSave = false;
  await drawer.getByRole("button", { name: "保存渠道", exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(frame.locator(".settings-channel")).toContainText("4 个创作模型");
  await expect(frame.getByRole("status")).toContainText("目录信息不代表已验证生成能力");
  expect(state.snapshot.channels[0]!.models.find(model => model.name === "gpt-image-fixture")!.id).toBe(imageId);
  expect(state.externalCalls).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("configuration-models-desktop.png") });
  await page.reload();
  await frame.getByRole("tab", { name: "模型管理", exact: true }).click();
  await expect(frame.locator(".settings-model-list")).toContainText("custom-image-manual", { timeout: 30_000 });
});

test("model deletion confirms, keeps failed removals visible, clears defaults and persists after reload", async ({ page }, testInfo) => {
  const { frame, state } = await fixture(page);
  state.snapshot.defaults.image = imageId;
  await frame.getByRole("button", { name: "刷新配置", exact: true }).click();
  await frame.getByRole("tab", { name: "模型管理", exact: true }).click();
  const remove = frame.getByRole("button", { name: "删除模型 gpt-image-fixture", exact: true });
  await remove.click();
  const confirmation = frame.getByRole("dialog", { name: "删除模型“gpt-image-fixture”？", exact: true });
  await expect(confirmation).toContainText("历史任务和生成文件保留");
  await confirmation.getByRole("button", { name: /^取\s*消$/ }).click();
  expect(state.requests.filter(input => input.operation === "model.remove")).toHaveLength(0);
  await expect(remove).toBeVisible();
  state.failRemove = true;
  await remove.click();
  await confirmation.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(frame.getByRole("alert")).toContainText("仍有排队或进行中的任务");
  await expect(confirmation).toBeVisible();
  expect(state.snapshot.channels[0]!.models).toHaveLength(1);
  state.failRemove = false;
  await confirmation.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(confirmation).toBeHidden();
  await frame.getByRole("tab", { name: "渠道管理", exact: true }).click();
  await expect(frame.locator(".settings-channel")).toContainText("0 个创作模型");
  expect(state.snapshot.defaults.image).toBeNull();
  expect(state.requests.filter(input => input.operation === "model.remove").at(-1)).toEqual({ operation: "model.remove", channelId, modelId: imageId, revision: "a".repeat(64) });
  await page.reload();
  await expect(frame.locator(".settings-channel")).toContainText("0 个创作模型", { timeout: 30_000 });
  await expect(remove).toHaveCount(0);
  expect(state.externalCalls).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("configuration-model-deleted-desktop.png") });
});

test("analysis model deletion cancels safely, shows server conflicts and refreshes defaults at mobile width", async ({ page }, testInfo) => {
  // Embedded browsers may not display native JavaScript dialogs. Confirmation
  // must be a real page element even when window.confirm cannot be used.
  await page.addInitScript(() => { window.confirm = () => { throw new Error("Native confirmation is unavailable in this browser"); }; });
  const { frame, state } = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  state.snapshot.analysisModels = [{ id: analysisId, label: "QA 图文分析", model: "qa-vision-model", providerLabel: "QA OpenAI", providerConfigId: channelId }];
  state.snapshot.defaults.analysis = analysisId;
  await frame.getByRole("tab", { name: "模型管理", exact: true }).click();
  await page.getByText("图文分析模型与费用设置", { exact: true }).click();
  const remove = page.getByRole("button", { name: "删除分析模型 QA 图文分析", exact: true });
  await expect(remove).toBeEnabled();
  await expect(frame.getByRole("button", { name: "删除模型 gpt-image-fixture", exact: true })).toBeVisible();
  expect(await frame.locator("html").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await remove.click();
  const confirmation = page.getByRole("dialog", { name: "删除模型“QA 图文分析”？", exact: true });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("历史分析结果和生成文件保留");
  await expect(confirmation.getByRole("button", { name: "取消", exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("configuration-model-delete-mobile.png") });
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(remove).toBeFocused();
  expect(state.requests.some(input => input.operation === "model.remove")).toBe(false);
  state.failRemove = true;
  await remove.click();
  await confirmation.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(confirmation.getByRole("alert")).toContainText("仍有排队或进行中的任务");
  await expect(confirmation).toBeVisible();
  state.failRemove = false;
  let finishRemoval!: () => void;
  state.holdRemoval = new Promise<void>(resolve => { finishRemoval = resolve; });
  await confirmation.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(confirmation.getByRole("button", { name: "正在删除…", exact: true })).toBeDisabled();
  await expect(confirmation.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeVisible();
  finishRemoval();
  await expect(confirmation).toBeHidden();
  await expect(page.getByText("模型已删除，历史分析结果保留。", { exact: true })).toBeVisible();
  await expect(remove).toHaveCount(0);
  await expect(page.getByText("尚未配置图文分析模型。", { exact: true })).toBeVisible();
  expect(state.snapshot.defaults.analysis).toBeNull();
  await frame.getByRole("tab", { name: "默认模型", exact: true }).click();
  await expect(frame.locator(".settings-analysis-select")).toContainText("跟随默认文本模型");
  await page.reload();
  await frame.getByRole("tab", { name: "模型管理", exact: true }).click();
  await page.getByText("图文分析模型与费用设置", { exact: true }).click();
  await expect(page.getByText("尚未配置图文分析模型。", { exact: true })).toBeVisible();
  expect(state.externalCalls).toEqual([]);
});

test("shared analysis deletion explains its scope and Escape cancels without a native dialog", async ({ page }, testInfo) => {
  await page.addInitScript(() => { window.confirm = () => { throw new Error("Native confirmation is unavailable in this browser"); }; });
  const { frame, state } = await fixture(page);
  state.snapshot.channels[0]!.models.push({ id: analysisId, label: "QA 共用文本", name: "qa-shared-text", capability: "text" });
  state.snapshot.analysisModels = [{ id: analysisId, label: "QA 共用文本", model: "qa-shared-text", providerLabel: "QA OpenAI", providerConfigId: channelId }];
  await frame.getByRole("tab", { name: "模型管理", exact: true }).click();
  await page.getByText("图文分析模型与费用设置", { exact: true }).click();
  const remove = page.getByRole("button", { name: "删除分析模型 QA 共用文本", exact: true });
  await remove.click();
  const confirmation = page.getByRole("dialog", { name: "删除模型“QA 共用文本”？", exact: true });
  await expect(confirmation).toContainText("删除后也不能再用于文字创作");
  await expect(confirmation).toContainText("QA OpenAI · qa-shared-text");
  await page.screenshot({ path: testInfo.outputPath("configuration-model-delete-desktop.png") });
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await expect(remove).toBeFocused();
  expect(state.requests.some(input => input.operation === "model.remove")).toBe(false);
  expect(state.externalCalls).toEqual([]);
});

test("channel removal shows its models, handles conflicts and pending state, and persists after reload", async ({ page }, testInfo) => {
  await page.addInitScript(() => { window.confirm = () => { throw new Error("Native confirmation is unavailable"); }; });
  const { frame, state } = await fixture(page);
  state.snapshot.channels[0]!.analysisModels = [{ id: analysisId, name: "qa-analysis", label: "QA Analysis" }];
  state.snapshot.analysisModels = [{ id: analysisId, model: "qa-analysis", label: "QA Analysis", providerLabel: "QA OpenAI", providerConfigId: channelId }];
  state.snapshot.defaults = { ...emptyModelDefaults(), image: imageId, analysis: analysisId };
  await frame.getByRole("button", { name: "刷新配置", exact: true }).click();
  await expect(frame.getByRole("button", { name: "删除模型 gpt-image-fixture", exact: true })).toBeHidden();
  await expect(page.getByText("图文分析模型与费用设置", { exact: true })).toBeHidden();
  const remove = frame.getByRole("button", { name: "删除渠道 QA OpenAI", exact: true });
  await remove.click();
  const confirmation = frame.getByRole("dialog", { name: "删除渠道“QA OpenAI”？", exact: true });
  await expect(confirmation).toContainText("2 个模型配置");
  await expect(confirmation).toContainText("gpt-image-fixture");
  await expect(confirmation).toContainText("qa-analysis");
  await expect(confirmation).toContainText("历史任务和生成文件保留");
  await page.screenshot({ path: testInfo.outputPath("channel-delete-desktop.png") });
  await confirmation.getByRole("button", { name: /^取\s*消$/ }).click();
  await expect(confirmation).toBeHidden();
  expect(state.requests.some(input => input.operation === "channel.remove")).toBe(false);
  state.failRemove = true;
  await remove.click();
  await confirmation.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(confirmation.getByRole("alert")).toContainText("仍有排队或进行中的任务");
  expect(state.snapshot.channels).toHaveLength(1);
  state.failRemove = false;
  let finish!: () => void;
  state.holdRemoval = new Promise<void>(resolve => { finish = resolve; });
  await confirmation.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(confirmation.getByRole("button", { name: /^取\s*消$/ })).toBeDisabled();
  await frame.locator(".ant-modal").press("Escape");
  await expect(confirmation).toBeVisible();
  finish();
  await expect(confirmation).toBeHidden();
  await expect(remove).toHaveCount(0);
  expect(state.snapshot.defaults).toEqual(emptyModelDefaults());
  expect(state.requests.filter(input => input.operation === "channel.remove").at(-1)).toEqual({ operation: "channel.remove", id: channelId, revision: "a".repeat(64) });
  await page.reload();
  await expect(frame.getByText(/已配置 0 个渠道/)).toBeVisible({ timeout: 30_000 });
  await expect(remove).toHaveCount(0);
  expect(state.externalCalls).toEqual([]);
});

test("channel management stays separate and model filters and empty-channel deletion work at mobile width", async ({ page }, testInfo) => {
  const { frame, state } = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const secondId = "019a0000-0000-7000-8000-000000000020";
  state.snapshot.channels.push({ ...snapshot().channels[0]!, id: secondId, name: "QA Empty", status: "disabled", models: [] });
  await frame.getByRole("button", { name: "刷新配置", exact: true }).click();
  const emptyChannel = frame.getByRole("region", { name: "QA Empty", exact: true });
  await emptyChannel.getByRole("button", { name: "查看模型", exact: true }).click();
  await expect(frame.getByRole("tab", { name: "模型管理", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(frame.getByText("没有符合筛选条件的模型。", { exact: true })).toBeVisible();
  await frame.getByRole("combobox", { name: "筛选模型渠道", exact: true }).click();
  await frame.getByRole("option", { name: "全部渠道", exact: true }).click();
  await expect(frame.getByRole("button", { name: "删除模型 gpt-image-fixture", exact: true })).toBeVisible();
  await frame.getByRole("textbox", { name: "搜索模型", exact: true }).fill("missing-model");
  await expect(frame.getByText("没有符合筛选条件的模型。", { exact: true })).toBeVisible();
  await frame.getByRole("textbox", { name: "搜索模型", exact: true }).fill("QA OpenAI");
  await expect(frame.getByRole("button", { name: "删除模型 gpt-image-fixture", exact: true })).toBeVisible();
  await frame.getByRole("combobox", { name: "筛选模型用途", exact: true }).click();
  await frame.getByRole("option", { name: "视频", exact: true }).click();
  await expect(frame.getByText("没有符合筛选条件的模型。", { exact: true })).toBeVisible();
  expect(await frame.locator("html").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("model-management-mobile.png") });
  await frame.getByRole("tab", { name: "渠道管理", exact: true }).click();
  await emptyChannel.getByRole("button", { name: "删除渠道 QA Empty", exact: true }).click();
  const confirmation = frame.getByRole("dialog", { name: "删除渠道“QA Empty”？", exact: true });
  await expect(confirmation).toContainText("该渠道没有模型，可直接删除");
  await page.screenshot({ path: testInfo.outputPath("channel-delete-mobile.png") });
  await confirmation.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(emptyChannel).toHaveCount(0);
  await expect(frame.getByRole("region", { name: "QA OpenAI", exact: true })).toBeVisible();
  expect(state.snapshot.channels).toHaveLength(1);
  expect(state.externalCalls).toEqual([]);
});

test("manual fallback and OpenAI defaults remain usable at mobile width", async ({ page }, testInfo) => {
  const { frame, state } = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await frame.getByRole("button", { name: "添加渠道", exact: true }).click();
  const drawer = frame.getByRole("dialog", { name: "编辑渠道", exact: true });
  await expect(drawer.getByLabel("渠道名称", { exact: true })).toHaveValue("OpenAI");
  await expect(drawer.getByLabel("接口地址", { exact: true })).toHaveValue("https://api.openai.com/v1");
  await drawer.getByLabel("API Key", { exact: true }).fill("synthetic-credential-never-sent-to-provider");
  await drawer.getByRole("button", { name: "选择模型", exact: true }).click();
  const modal = frame.getByRole("dialog", { name: /选择渠道模型/ });
  state.failDiscover = true;
  await modal.getByRole("button", { name: "拉取模型列表", exact: true }).click();
  await expect(frame.getByText("渠道不提供模型目录，请手动填写模型名称", { exact: true })).toBeVisible();
  await modal.getByPlaceholder("输入模型名称", { exact: true }).fill("gpt-image-fixture");
  await modal.getByRole("button", { name: "增加模型", exact: true }).click();
  await expect(modal.getByRole("checkbox", { name: "gpt-image-fixture", exact: true })).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await frame.locator("html").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("configuration-discovery-mobile.png") });
  await modal.getByRole("button", { name: /^确\s*定$/ }).click();
  await drawer.getByRole("button", { name: /^取\s*消$/ }).click();
  await frame.getByRole("tab", { name: "默认模型", exact: true }).click();
  await frame.locator(".settings-defaults > div").first().getByRole("combobox").click();
  await frame.getByRole("option", { name: /gpt-image-fixture/ }).click();
  await frame.getByRole("button", { name: "保存默认模型", exact: true }).click();
  await expect.poll(() => state.snapshot.defaults.image).toBe(imageId);
  await expect(frame.getByRole("button", { name: "保存默认模型", exact: true })).toBeDisabled();
  await expect(frame.getByRole("button", { name: "刷新配置", exact: true })).toBeEnabled();
  await page.reload();
  await expect(frame.getByRole("tab", { name: "默认模型", exact: true })).toBeVisible({ timeout: 30_000 });
  await frame.getByRole("tab", { name: "默认模型", exact: true }).click();
  await expect(frame.locator(".settings-defaults > div").first().getByRole("combobox")).toContainText("gpt-image-fixture");
  expect(await frame.locator("html").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(state.externalCalls).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("configuration-defaults-mobile.png") });
});
