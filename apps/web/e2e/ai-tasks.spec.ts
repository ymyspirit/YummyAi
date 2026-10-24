import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { KnowledgeWorkspace } from "@yummyai/contracts/knowledge";
import {
  ASSIST_TASKS,
  type AssistTaskBasis,
  type AssistTaskWorkspace,
} from "@yummyai/contracts/ai/task-workspace";
import type { AssistView } from "@yummyai/contracts/ai/assist";
import { centerApi } from "./order-centers-fixture";
import { knowledgeGovernanceFixture } from "./knowledge-governance-fixture";

test("AI task workspace runs a pinned business task and recovers it on desktop and mobile", async ({
  page,
}, testInfo) => {
  test.setTimeout(180000);
  const fixture = await knowledgeGovernanceFixture();
  const errors: string[] = [],
    paidSubmissions: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/ai-assists/runs")
      paidSubmissions.push(request.url());
  });
  try {
    const created = await centerApi<{ id: string; revision: number }>("knowledge/create", {
      fields: {
        title: "Synthetic 任务资料核对",
        summary: "Synthetic task acceptance",
        body: "先核对资料并保留复核记录。",
        topic: "operations",
        platform: "all",
        market: "ALL",
        spuId: null,
        sourceType: "team",
        sourceLabel: "Synthetic team SOP",
        sourceUrl: "",
        owner: "Synthetic operator",
        verifiedOn: "2020-01-01",
        reviewDueOn: "2099-12-31",
        tags: ["资料核对"],
      },
      expectedRevision: 0,
      reason: "Synthetic acceptance",
      requestId: randomUUID(),
    });
    let entry = (await centerApi<KnowledgeWorkspace>("knowledge/workspace")).entries.find(
      (entry) => entry.id === created.id,
    )!;
    await centerApi(`knowledge/${created.id}/submit`, {
      expectedRevision: entry.revision,
      version: entry.latestVersion,
      reason: "Synthetic review",
      requestId: randomUUID(),
    });
    entry = (await centerApi<KnowledgeWorkspace>("knowledge/workspace")).entries.find(
      (entry) => entry.id === created.id,
    )!;
    await centerApi(`knowledge/${created.id}/publish`, {
      expectedRevision: entry.revision,
      version: entry.latestVersion,
      reason: "Synthetic approved evidence",
      requestId: randomUUID(),
    });
    for (const task of ASSIST_TASKS) {
      const targets = await centerApi<{ items: unknown[] }>(
        `ai-assists/task-targets?kind=${task.kind}`,
      );
      expect(Array.isArray(targets.items)).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/ai-tasks");
    await expect(page.getByRole("heading", { name: "AI 任务工作台", exact: true })).toBeVisible();
    await expect(page.getByLabel("要完成的任务").locator("option")).toHaveCount(9);
    await expect(page.getByText("暂无匹配的业务对象。", { exact: false })).toBeVisible();
    await page.getByLabel("要完成的任务").selectOption("knowledge_answer");
    await page.getByLabel("需要查证的问题").fill("资料核对应如何保留复核记录？");
    await page.getByRole("button", { name: "读取本次依据", exact: true }).click();
    await expect(page.getByRole("region", { name: "本次任务依据", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "本次任务依据" })).toContainText(
      "Synthetic 任务资料核对",
    );
    expect(paidSubmissions).toHaveLength(0);
    // Editing the goal invalidates the previously inspected sources immediately.
    await page.getByLabel("需要查证的问题").fill("资料核对后需要保存什么复核记录？");
    await expect(page.getByRole("region", { name: "本次任务依据", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "读取本次依据", exact: true }).click();
    await expect(page.getByRole("region", { name: "本次任务依据", exact: true })).toBeVisible();
    await page.getByLabel("图文模型").selectOption(fixture.modelId);
    const submitted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/ai-assists/runs",
    );
    await page.getByRole("button", { name: "开始分析", exact: true }).click();
    const task = (await (await submitted).json()) as AssistView;
    expect(task.status).toBe("queued");
    expect(task.executionContract?.tools.map(tool => tool.key)).toEqual(["yummyai.assist.knowledge_answer"]);
    expect(task.request?.taskGoal).toBe("资料核对后需要保存什么复核记录？");
    await page.goto(`/ai-tasks?run=${task.id}`);
    await expect(
      page.getByText("任务在后台运行，可以离开此页，稍后查看记录。", { exact: false }),
    ).toBeVisible();
    await page.reload();
    expect(paidSubmissions).toHaveLength(1);
    await fixture.answer(task.id);
    await expect(page.getByText("核对流程", { exact: true })).toBeVisible();
    await expect(
      page.locator(".ai-assist-report > p", { hasText: "先核对资料并保留复核记录。" }),
    ).toBeVisible();
    await expect(
      page.getByText("Synthetic 任务资料核对 · v1", { exact: false }).first(),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "进入业务页面核对与处理" })).toHaveAttribute(
      "href",
      "/knowledge",
    );
    const workspace = await centerApi<AssistTaskWorkspace>("ai-assists/task-workspace");
    expect(workspace.items.find((row) => row.id === task.id)).toMatchObject({
      status: "completed",
      stale: false,
    });
    const invocation=page.getByRole("region",{name:"调用与费用记录",exact:true});
    await invocation.getByRole("button",{name:"调用与费用记录",exact:true}).click();
    await expect(invocation.getByText("已保存响应回执",{exact:false})).toBeVisible();
    await expect(invocation.getByText("费用需结合渠道原请求及账单核对",{exact:true})).toBeVisible();
    const downloadEvent=page.waitForEvent("download");await invocation.getByRole("button",{name:"下载核对记录",exact:true}).click();
    const download=await downloadEvent,downloadPath=testInfo.outputPath("assist-execution-evidence.json");await download.saveAs(downloadPath);
    const exported=JSON.parse(await readFile(downloadPath,"utf8"));expect(exported).toMatchObject({version:"harness-reconciliation-handoff-v1",providerInvoiceVerified:false,invocations:[{owner:"assist",id:task.id,boundary:"received",billing:{basis:"configured_rate",needsProviderEvidence:true}}]});
    expect(JSON.stringify(exported)).not.toContain("先核对资料并保留复核记录");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      await expect(page.getByRole("heading", { name: "AI 任务工作台", exact: true })).toBeVisible();
      // Phone history starts collapsed. Finish its actual interaction and transition before capturing.
      if (width === 390) await page.getByRole("button", { name: "展开任务历史", exact: true }).click();
      await expect(page.locator("#at-history-content")).toHaveCSS("opacity", "1");
      await expect(page.getByRole("complementary", { name: "我的任务历史" }).getByText("Synthetic 任务资料核对 · v1", { exact: false })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`ai-tasks-${width}.png`), fullPage: true });
    }
    expect(paidSubmissions).toHaveLength(1);
    expect(errors).toEqual([]);
    // A forged preview is rejected before creating a second paid task.
    const basis = await centerApi<AssistTaskBasis>("ai-assists/task-basis", {
      kind: "knowledge_answer",
      targetId: null,
      taskGoal: "资料核对",
    });
    expect(basis.sources.length).toBeGreaterThan(0);
    const rejected = await page.request.post("/api/ai-assists/runs", {
      headers: { origin: new URL(page.url()).origin },
      data: {
        ...basis.input,
        modelId: fixture.modelId,
        requestId: randomUUID(),
        expectedTaskFingerprint: "0".repeat(64),
      },
    });
    expect(rejected.status()).toBe(409);
    expect((await centerApi<AssistTaskWorkspace>("ai-assists/task-workspace")).items).toHaveLength(
      1,
    );

    const injected = await page.request.post("/api/ai-assists/runs", {
      headers: { origin: new URL(page.url()).origin },
      data: { ...basis.input, modelId: fixture.modelId, requestId: randomUUID(), executionContract: task.executionContract },
    });
    expect(injected.status()).toBe(400);
    expect((await centerApi<AssistTaskWorkspace>("ai-assists/task-workspace")).items).toHaveLength(1);

    // Withdraw a real pinned source after admission. The Worker must stop before the paid boundary.
    const pending = await centerApi<AssistView>("ai-assists/runs", {
      kind: "knowledge_answer", scopeId: randomUUID(), modelId: fixture.modelId, requestId: randomUUID(),
      search: { query: "Synthetic 任务资料核对", topic: "operations", platform: "all", market: "ALL", spuIds: [] },
      evidenceStoreId: null, previousRunId: null,
    });
    expect(pending.inputAuthority?.version).toBe("assist-input-authority-v1");
    entry = (await centerApi<KnowledgeWorkspace>("knowledge/workspace")).entries.find(e => e.id === created.id)!;
    await centerApi(`knowledge/${created.id}/disable`, { expectedRevision: entry.revision, version: entry.latestVersion, reason: "Synthetic withdrawal before execution", requestId: randomUUID() });
    const calls = fixture.modelCalls();
    await fixture.answer(pending.id);
    const failed = await centerApi<AssistView>(`ai-assists/runs/${pending.id}`);
    expect(failed).toMatchObject({ status: "failed", costUsd: null, result: null, budgetState: "released" });
    expect(failed.diagnostics.join(" ")).toContain("知识");
    expect(fixture.modelCalls()).toBe(calls);
    await page.goto(`/ai-tasks?run=${pending.id}`);
    await expect(page.getByText("任务依据的版本、状态或有效期已变化；请重新读取当前依据后分析，已产生的费用记录保留", { exact: true })).toBeVisible();
    await expect(page.getByText("费用预留已释放", { exact: true })).toBeVisible();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      if (width === 390) await page.getByRole("button", { name: "展开任务历史", exact: true }).click();
      await expect(page.locator("#at-history-content")).toHaveCSS("opacity", "1");
      await expect(page.getByText(/执行依据已变化：知识发布版与来源/)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`ai-stale-${width}.png`), fullPage: true });
    }
    expect(fixture.modelCalls()).toBe(calls); expect(errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});
