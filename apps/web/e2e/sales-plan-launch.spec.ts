import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { AssistView } from "@yummyai/contracts/ai/assist";
import type { SalesPlanDetail } from "@yummyai/contracts/catalog/sales-plan";
import type { SalesPlanLaunch } from "@yummyai/contracts/catalog/sales-plan-launch";
import type { PreparationView } from "@yummyai/contracts/catalog/sales-plan-agent";
import { centerApi } from "./order-centers-fixture";
import { knowledgeGovernanceFixture } from "./knowledge-governance-fixture";
import { salesLaunchFixture } from "./sales-plan-launch-fixture";

test("sales plan launch preparation agent resumes committed tools and authorized analysis without duplicate drafts", async ({ page }, info) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(20000);
  const model = await knowledgeGovernanceFixture("preparation");
  const fixture = await salesLaunchFixture({ pillow: true }).catch(async error => { await model.close(); throw error; });
  const errors: string[] = [], writes: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.method() === "POST" && request.url().includes("/launch/agent")) writes.push(new URL(request.url()).pathname); });
  const directory = new URL("../../../tmp/sales-launch-e2e/", import.meta.url);
  mkdirSync(directory, { recursive: true });
  try {
    let detail = await centerApi<SalesPlanDetail>(`sales-plans/${fixture.planId}`);
    await centerApi(`sales-plans/${fixture.planId}`, { expectedRevision: detail.plan.revision,
      fields: { ...detail.plan.fields, title: `${detail.plan.fields.title} Gift` }, idempotencyKey: randomUUID() });
    let loseResponse = true;
    await page.route(`**/api/sales-plans/${fixture.planId}/launch/agent`, async route => {
      if (route.request().method() === "POST" && loseResponse) {
        loseResponse = false;
        const result = await route.fetch();
        expect(result.ok()).toBe(true);
        await route.abort("failed");
      } else await route.continue();
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/sales-plans?plan=${fixture.planId}&view=tasks`);
    const agent = page.getByRole("region", { name: "上架准备 Agent", exact: true });
    await agent.getByRole("button", { name: "检查并准备草稿", exact: true }).click();
    await expect(agent.getByRole("alert")).toBeVisible();
    await page.reload();
    await expect(agent.locator(".sp-agent-summary")).toContainText("可提交审核");
    const runId = new URL(page.url()).searchParams.get("preparation")!;
    expect(runId).toBeTruthy();
    const saved = await centerApi<PreparationView>(`sales-plans/${fixture.planId}/launch/agent/${runId}`);
    expect(saved.run.evidence.some(source => source.kind === "specification" && source.version === fixture.spec.versionId)).toBe(true);
    detail = await centerApi<SalesPlanDetail>(`sales-plans/${fixture.planId}`);
    const version = detail.listings[0]!.version;
    expect(detail.listings[0]!.planRevision).toBe(2);
    expect(detail.listings[0]!.status).toBe("draft");
    expect(writes.filter(path => path.endsWith("/agent"))).toHaveLength(1);
    await page.reload();
    await expect(agent.locator(".sp-agent-summary")).toContainText("可提交审核");
    expect((await centerApi<SalesPlanDetail>(`sales-plans/${fixture.planId}`)).listings[0]!.version).toBe(version);
    await agent.getByRole("combobox", { name: "Agent 分析环节" }).selectOption("creative");
    await agent.getByRole("button", { name: "读取 Agent 分析依据" }).click();
    await expect(agent.getByRole("region", { name: "Agent 分析依据" })).toContainText("固定来源");
    await agent.getByRole("combobox", { name: "Agent 分析模型" }).selectOption(model.modelId);
    const submitted = page.waitForResponse(response => response.url().endsWith(`/agent/${runId}/analyze`) && response.request().method() === "POST");
    await agent.getByRole("button", { name: "确认依据并开始分析" }).click();
    const response = await submitted;
    expect(response.ok()).toBe(true);
    const analysis = (await response.json() as PreparationView).analysis!;
    await model.analyze(analysis.id, {
      summary: "Synthetic preparation direction", findings: [], matches: [], missingInformation: [],
      directions: Array.from({ length: 3 }, (_, i) => ({ title: `Synthetic preparation direction ${i + 1}`,
        rationale: "Original synthetic composition", prompt: "Prepare an original name layout", negativePrompt: "Do not copy references",
        requirements: { mode: "personalized_text", audience: "Synthetic buyers", occasion: "Synthetic gifting", style: "Original typography" },
        fields: [], evidence: [{ sourceId: fixture.source.snapshotId, detail: "Pinned synthetic research" }] })),
    });
    await expect(agent.getByLabel("Agent 分析结果")).toContainText("分析完成");
    await page.reload();
    await expect(agent.getByLabel("Agent 分析结果")).toContainText("分析完成");
    expect(writes.filter(path => path.endsWith("/analyze"))).toHaveLength(1);
    await agent.getByRole("link", { name: "查看并核对建议" }).click();
    await expect(page.getByRole("region", { name: "AI 成果差异与采纳" })).toContainText("Synthetic preparation direction");
    await page.getByRole("checkbox", { name: "设计定位", exact: true }).check();
    await page.getByRole("button", { name: "采纳所选字段并保存", exact: true }).click();
    await expect(agent.getByRole("button", { name: "按 V3 继续任务" })).toBeEnabled();
    await agent.getByRole("button", { name: "按 V3 继续任务" }).click();
    await expect(agent.locator(".sp-agent-summary")).toContainText("可提交审核");
    detail = await centerApi<SalesPlanDetail>(`sales-plans/${fixture.planId}`);
    expect(detail.listings[0]!.planRevision).toBe(3);
    expect(detail.listings[0]!.status).toBe("draft");
    await agent.evaluate(element => element.scrollIntoView({ block: "start" }));
    await expect(agent.getByRole("heading", { name: "上架准备 Agent" })).toBeInViewport();
    await page.screenshot({ path: info.outputPath("preparation-desktop.png"), fullPage: true });
    await agent.screenshot({ path: info.outputPath("preparation-desktop-region.png") });
    await fixture.mutateAsset();
    await agent.getByRole("button", { name: "刷新上架准备任务" }).click();
    await expect(agent.locator(".sp-agent-summary")).toContainText("资料已变化");
    await agent.getByRole("button", { name: "按 V3 继续任务" }).click();
    await expect(agent.locator(".sp-agent-summary")).toContainText("待处理");
    await expect(agent.getByLabel("Agent 执行计划")).toContainText("补齐主图");
    await expect(agent.getByLabel("Agent 执行计划")).toContainText("请先补齐上方资料");
    await page.setViewportSize({ width: 390, height: 844 });
    await agent.evaluate(element => element.scrollIntoView({ block: "start" }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("preparation-narrow.png"), fullPage: true });
    await agent.screenshot({ path: info.outputPath("preparation-narrow-region.png") });
    await agent.getByRole("button", { name: "停止任务" }).click();
    await expect(agent.locator(".sp-agent-summary")).toContainText("已停止");
    await page.reload();
    await expect(agent.locator(".sp-agent-summary")).toContainText("已停止");
    await expect(agent.getByRole("button", { name: "继续原任务" })).toHaveCount(0);
    const completedWrites = writes.length;
    await page.goto(`/ai-tasks?business=1&object=sales_plan&target=${fixture.planId}`);
    await expect(page.getByRole("heading", { name: "业务任务", exact: true })).toBeVisible();
    await expect(page.locator(".business-task-heading")).toContainText("已停止");
    await expect(page.getByRole("link", { name: "打开原方案继续上架准备" })).toHaveAttribute("href", `/sales-plans?plan=${fixture.planId}&view=tasks`);
    await page.reload();
    await expect(page.locator(".business-task-heading")).toContainText("已停止");
    expect(writes).toHaveLength(completedWrites);
    expect(errors).toEqual([]);
    writeFileSync(new URL(`preparation-${fixture.planId}.json`, directory), JSON.stringify({
      fixtureIds: fixture.ids, runId, analysisId: analysis.id, writes, pageErrors: errors,
      beforeVersion: version, afterVersion: detail.listings[0]!.version,
      duplicateModelSubmissions: 0, marketplaceWrites: 0, approvalWrites: 0,
      modelTransport: "synthetic", cleanup: "disposable runner owns database, bucket and Redis",
    }, null, 2));
  } finally { await Promise.all([fixture.close(), model.close()]); }
});

test("sales plan launch adopts pinned AI work, resumes without calls and exports a current reviewed Custom package", async ({
  page,
}, info) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(20000);
  const model = await knowledgeGovernanceFixture("launch");
  const fixture = await salesLaunchFixture().catch(async (error) => {
    await model.close();
    throw error;
  });
  const paid: string[] = [],
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/ai-assists/runs")
      paid.push(request.url());
  });
  const manifestDirectory = new URL("../../../tmp/sales-launch-e2e/", import.meta.url);
  mkdirSync(manifestDirectory, { recursive: true });
  const proof: Record<string, unknown> = {
    fixtureIds: fixture.ids,
    modelTransport: "controlled synthetic only",
    marketplaceWrites: 0,
    productionRelease: false,
    cleanup: "owned by disposable runner",
  };
  const persist = () =>
    writeFileSync(
      new URL(`browser-${fixture.planId}.json`, manifestDirectory),
      JSON.stringify({ ...proof, paidSubmissions: paid.length, pageErrors: errors }, null, 2),
    );
  persist();
  const analyze = async (result: unknown) => {
    await page.getByRole("combobox", { name: "图文模型", exact: true }).selectOption(model.modelId);
    const submission = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/ai-assists/runs" &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "开始分析", exact: true }).click();
    const response = await submission;
    expect(response.ok(), `Analysis submission: ${response.status()}`).toBe(true);
    const run = (await response.json()) as AssistView;
    await model.analyze(run.id, result);
    await expect(page.locator(".ai-assist-meta")).toContainText("分析完成");
    return run.id;
  };
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/sales-plans?plan=${fixture.planId}&view=tasks`);
    await expect(page.getByRole("region", { name: "商品上新任务", exact: true })).toBeVisible();
    await expect(page.getByLabel("下一步处理")).toContainText("原创方向");
    await page.getByRole("button", { name: "读取上新依据", exact: true }).click();
    await expect(page.getByRole("region", { name: "上新分析依据" })).toContainText("60 × 40 mm");
    expect(paid).toHaveLength(0);
    const evidence = [{ sourceId: fixture.source.snapshotId, detail: "Synthetic fixed research" }];
    const first = await analyze({
      summary: "Synthetic original direction based on the pinned product",
      findings: [],
      directions: Array.from({ length: 3 }, (_, index) => ({
        title: `Synthetic original name layout ${index + 1}`,
        rationale: "Synthetic original contrast and spacing",
        prompt: "Create an original editable name layout",
        negativePrompt: "Do not copy competitors",
        requirements: {
          mode: "personalized_text",
          audience: "Synthetic suggested audience",
          occasion: "Synthetic suggested occasion",
          style: "Original simple typography",
        },
        fields: [],
        evidence,
      })),
      matches: [],
      missingInformation: [],
    });
    await expect(page.getByRole("region", { name: "AI 成果差异与采纳" })).toContainText(
      "Synthetic original name layout",
    );
    await page.getByRole("checkbox", { name: "设计定位", exact: true }).check();
    let failOnce = true;
    await page.route(`**/api/sales-plans/${fixture.planId}/launch/adopt`, async (route) => {
      if (failOnce) {
        failOnce = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "Synthetic interruption: selected fields retained" }),
        });
      } else await route.continue();
    });
    await page.getByRole("button", { name: "采纳所选字段并保存", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "商品上新任务", exact: true }).getByRole("alert"),
    ).toContainText("selected fields retained");
    await expect(page.getByRole("checkbox", { name: "设计定位", exact: true })).toBeChecked();
    await page.getByRole("button", { name: "采纳所选字段并保存", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "已采纳所选字段" })).toBeVisible();
    let detail = await centerApi<SalesPlanDetail>(`sales-plans/${fixture.planId}`);
    expect(detail.plan.fields.audience).toBe("Synthetic original buyers");
    expect(detail.plan.fields.positioning).toContain("Synthetic original name layout");
    expect(detail.plan.revision).toBe(2);
    await page.reload();
    await expect(page.locator(".sl-history")).toContainText("已采纳");
    expect(paid).toHaveLength(1);
    expect(new URL(page.url()).searchParams.get("launchRun")).toBe(first);
    await centerApi(`sales-plans/${fixture.planId}/draft`, {
      expectedRevision: detail.plan.revision,
      expectedListingVersionId: detail.listings[0]!.versionId,
      idempotencyKey: randomUUID(),
    });
    await page.getByRole("combobox", { name: "分析环节", exact: true }).selectOption("sku_package");
    await page.getByRole("button", { name: "读取上新依据", exact: true }).click();
    await expect(page.getByRole("region", { name: "上新分析依据" })).toContainText("当前 Listing");
    const productEvidence = [
      { sourceId: fixture.spec.versionId, detail: "Synthetic confirmed product dimensions" },
    ];
    await analyze({
      summary: "Synthetic listing copy grounded in confirmed facts",
      findings: [],
      directions: [],
      matches: [],
      missingInformation: [],
      listingCopy: {
        title: "Synthetic Personalized Name Fabric Gift Panel",
        description:
          "Synthetic reviewed single fabric panel measuring 60 by 40 mm, customized with the supplied name. Enter the name in the configured customization field. This content is only an acceptance fixture.",
        bullets: [
          "Synthetic original name print",
          "Synthetic 60 by 40 mm panel",
          "Synthetic single panel",
          "Synthetic gift scene",
          "Synthetic customer name instructions",
        ],
        tags: [],
        personalizationInstructions: "Enter a name up to 20 characters.",
        imageDescriptions: [],
        evidence: productEvidence,
      },
    });
    await page
      .getByRole("region", { name: "AI 成果差异与采纳", exact: true })
      .getByRole("checkbox", { name: "标题", exact: true })
      .check();
    await page
      .getByRole("region", { name: "AI 成果差异与采纳", exact: true })
      .getByRole("checkbox", { name: "商品描述", exact: true })
      .check();
    await page.getByRole("button", { name: "采纳所选字段并保存", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "已采纳所选字段" })).toBeVisible();
    detail = await centerApi<SalesPlanDetail>(`sales-plans/${fixture.planId}`);
    expect(detail.plan.revision).toBe(3);
    expect(detail.plan.fields.title).toBe("Synthetic Personalized Name Fabric Gift Panel");
    expect(detail.plan.fields.bullets[0]).toBe("Synthetic original name print");
    const exported = await fixture.finish();
    expect(exported.manifest.listing.content.title).toBe(detail.plan.fields.title);
    expect(exported.byteSize).toBeGreaterThan(1000);
    proof.export = {
      packageId: exported.packageId,
      checksum: exported.checksum,
      byteSize: exported.byteSize,
      listingVersionId: exported.manifest.listing.versionId,
    };
    await page.reload();
    await expect(page.getByLabel("下一步处理")).toContainText("当前上新资料包已齐套");
    await expect(page.locator('.sl-stages li[data-status="ready"]')).toHaveCount(6);
    await expect(page.getByRole("region", { name: "当前封存资料包" })).toContainText("资料包 V1");
    expect(paid).toHaveLength(2);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await page.screenshot({ path: info.outputPath(`sales-launch-${width}.png`), fullPage: true });
    }
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.screenshot({ path: info.outputPath("sales-launch-dark-390.png"), fullPage: true });
    await fixture.mutateAsset();
    await page.getByRole("button", { name: "刷新进度", exact: true }).click();
    await expect(page.getByLabel("下一步处理")).toContainText("图稿与套图");
    const changed = await centerApi<SalesPlanLaunch>(`sales-plans/${fixture.planId}/launch`);
    expect(changed.packages).toHaveLength(0);
    expect(changed.stages.find((stage) => stage.key === "package")?.status).toBe("blocked");
    expect(errors).toEqual([]);
    persist();
  } finally {
    persist();
    await fixture.close();
    await model.close();
  }
});
