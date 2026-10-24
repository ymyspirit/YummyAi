import { expect, test } from "@playwright/test";
import type { KnowledgeWorkspace } from "@yummyai/contracts/knowledge";
import { KnowledgeFieldsSchema } from "@yummyai/contracts/knowledge";
import type {
  KnowledgeGovernanceView,
  KnowledgeEvaluationReport,
  KnowledgeDocumentView,
} from "@yummyai/contracts/knowledge/governance";
import type { AssistView } from "@yummyai/contracts/ai/assist";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import { centerApi } from "./order-centers-fixture";
import { knowledgeGovernanceFixture } from "./knowledge-governance-fixture";

test("knowledge dialogue clears a completed wider-scope answer after current scope is narrowed", async ({
  page,
}, testInfo) => {
  await page.clock.install();
  const fixture = await knowledgeGovernanceFixture("scope-boundary");
  let cardId: string | undefined;
  let releaseLate: () => void = () => {};
  try {
    const fields = KnowledgeFieldsSchema.parse({
      title: "Synthetic scope-boundary SOP",
      summary: "Scoped knowledge fixture",
      body: "Synthetic scope-boundary operating facts",
      topic: "operations",
      platform: "amazon",
      market: "US",
      spuId: null,
      sourceType: "team",
      sourceLabel: "Synthetic reviewed SOP",
      sourceUrl: "",
      owner: "Synthetic operator",
      verifiedOn: "2026-01-01",
      reviewDueOn: "2099-12-31",
      tags: [],
    });
    const card = await centerApi<{ id: string }>("knowledge/create", {
      fields,
      expectedRevision: 0,
      reason: "Synthetic controlled source",
      requestId: randomUUID(),
    });
    cardId = card.id;
    for (const action of ["submit", "publish"]) {
      const entry = (await centerApi<KnowledgeWorkspace>("knowledge/workspace")).entries.find(
        (row) => row.id === card.id,
      )!;
      await centerApi(`knowledge/${card.id}/${action}`, {
        expectedRevision: entry.revision,
        version: entry.latestVersion,
        reason: "Synthetic reviewed scope",
        requestId: randomUUID(),
      });
    }
    const scopeId = randomUUID();
    const run = await centerApi<AssistView>("ai-assists/runs", {
      kind: "knowledge_answer",
      purpose: "dialogue",
      scopeId,
      search: { query: fields.body, topic: "all", platform: "amazon", market: "US", spuIds: [] },
      evidenceStoreId: null,
      previousRunId: null,
      modelId: fixture.modelId,
      requestId: randomUUID(),
    });
    await fixture.answer(run.id);
    await page.goto("/knowledge?tab=chat");
    const chat = page.getByRole("region", { name: "知识对话", exact: true });
    await chat.getByLabel("最近对话", { exact: true }).selectOption(scopeId);
    await expect(
      chat.getByText("先核对资料并保留复核记录。", { exact: true }).first(),
    ).toBeVisible();
    await chat.getByLabel("问题或追问", { exact: true }).fill("Synthetic private scope follow-up");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`knowledge-scope-${width}.png`),
        fullPage: false,
      });
    }
    let capturedStatus = 0;
    let captured: () => void = () => {};
    const capturedResponse = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const holdResponse = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    await page.route(
      `**/api/ai-assists/runs/${run.id}`,
      async (route) => {
        const response = await route.fetch();
        capturedStatus = response.status();
        captured();
        await holdResponse;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await capturedResponse;
    expect(capturedStatus).toBe(200);
    await fixture.setDataScope("self");
    const history = await centerApi<Array<{ scopeId: string }>>(
      "knowledge-governance/conversations",
    );
    expect(history.some((row) => row.scopeId === scopeId)).toBe(false);
    const denied = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/ai-assists/runs/${run.id}`) &&
        response.request().method() === "GET",
    );
    await page.clock.fastForward(31000);
    expect((await denied).status()).toBe(403);
    await expect(chat.getByText("先核对资料并保留复核记录。", { exact: true })).toHaveCount(0);
    await expect(chat.getByLabel("问题或追问", { exact: true })).toHaveValue("");
    await expect(
      chat.getByLabel("最近对话", { exact: true }).locator(`option[value="${scopeId}"]`),
    ).toHaveCount(0);
    const late = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/ai-assists/runs/${run.id}`) && response.status() === 200,
    );
    releaseLate();
    await (await late).finished();
    await page.clock.runFor(100);
    await expect(chat.getByText("先核对资料并保留复核记录。", { exact: true })).toHaveCount(0);
  } finally {
    releaseLate();
    try {
      await fixture.setDataScope("tenant");
      if (cardId) {
        const entry = (await centerApi<KnowledgeWorkspace>("knowledge/workspace")).entries.find(
          (row) => row.id === cardId,
        );
        if (entry)
          await centerApi(`knowledge/${cardId}/archive`, {
            expectedRevision: entry.revision,
            version: entry.latestVersion,
            reason: "Synthetic scope fixture teardown",
            requestId: randomUUID(),
          });
      }
    } finally {
      await fixture.close();
    }
  }
});

test("native knowledge import, review, retrieval and immutable history on real API paths", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  expect((await centerApi<KnowledgeWorkspace>("knowledge/workspace")).entries).toEqual([]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/navigation?group=knowledge");
  const directory = page.locator(".erp-directory-entries");
  await expect(directory.getByRole("link", { name: "规则中心", exact: false })).toBeVisible();
  const workspaceResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/knowledge/workspace"),
  );
  await directory.getByRole("link", { name: "运营知识库", exact: false }).click();
  expect((await workspaceResponse).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "运营知识库", exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "当前位置" })
      .getByRole("link", { name: "知识与规则", exact: true }),
  ).toBeVisible();
  const modules = page.getByRole("group", { name: "业务模块", exact: true });
  const navigation = page.getByRole("navigation", { name: "主导航", exact: true });
  await modules.getByRole("button", { name: "系统配置", exact: true }).click();
  await expect(navigation.getByRole("link", { name: "运营知识库", exact: true })).toHaveCount(0);
  await expect(navigation.getByRole("link", { name: "规则中心", exact: true })).toHaveCount(0);
  await modules.getByRole("button", { name: "知识与规则", exact: true }).click();
  await expect(navigation.getByRole("link", { name: "规则中心", exact: true })).toHaveAttribute(
    "href",
    "/settings/rules",
  );
  await page.getByRole("button", { name: "新建知识", exact: true }).click();
  await page.getByLabel("知识标题", { exact: true }).fill("Synthetic 抱枕 Listing 文案");
  await page.getByLabel("导入 Markdown / 文本", { exact: true }).setInputFiles({
    name: "synthetic-sop.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "抱枕 Listing 介绍定制照片上传流程；尺寸和材质引用已确认的商品规格。",
      "utf8",
    ),
  });
  await expect(page.getByLabel("知识正文", { exact: true })).toHaveValue(
    "抱枕 Listing 介绍定制照片上传流程；尺寸和材质引用已确认的商品规格。",
  );
  await page.getByRole("combobox", { name: "适用平台", exact: true }).selectOption("amazon");
  await page.getByLabel("适用站点", { exact: true }).fill("US");
  await page.getByLabel("来源名称", { exact: true }).fill("Synthetic team SOP");
  await page.getByLabel("负责人", { exact: true }).fill("Synthetic operator");
  await page.getByLabel("保存说明", { exact: true }).fill("Synthetic browser acceptance");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("草稿已保存，提交并审核发布后供 AI 使用")).toBeVisible();
  const draft = (await centerApi<KnowledgeWorkspace>("knowledge/workspace")).entries[0]!;
  expect(draft.activeVersion).toBeNull();
  const search = {
    query: "抱枕 Listing",
    topic: "listing",
    platform: "amazon",
    market: "US",
    spuIds: [],
  };
  expect(
    (await centerApi<{ references: unknown[] }>("knowledge/search", search)).references,
  ).toEqual([]);
  await page.getByRole("button", { name: "提交审核", exact: true }).click();
  await page.getByLabel("操作说明", { exact: true }).fill("Synthetic submit for review");
  await page.getByRole("button", { name: "确认提交审核", exact: true }).click();
  await page.getByRole("button", { name: "审核发布", exact: true }).click();
  await page.getByLabel("操作说明", { exact: true }).fill("Synthetic scope and source verified");
  await page.getByRole("button", { name: "确认审核发布", exact: true }).click();
  await expect(page.getByText("已启用 V1。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "检索验证", exact: true }).click();
  await page.getByRole("combobox", { name: "平台", exact: true }).selectOption("amazon");
  await page.getByLabel("站点", { exact: true }).fill("US");
  await page.getByLabel("检索问题", { exact: true }).fill("抱枕 Listing");
  await page.getByRole("button", { name: "检索知识", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Synthetic 抱枕 Listing 文案 · V1" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Synthetic 抱枕 Listing 文案 · V1", exact: true }).click();
  await expect(
    page.getByText("抱枕 Listing 介绍定制照片上传流程；尺寸和材质引用已确认的商品规格。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "查看版本", exact: true })).toHaveValue("1");
  await page.getByRole("button", { name: "检索验证", exact: true }).click();
  await page.getByRole("combobox", { name: "平台", exact: true }).selectOption("etsy");
  await expect(page.getByRole("heading", { name: "Synthetic 抱枕 Listing 文案 · V1" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "检索知识", exact: true }).click();
  await expect(
    page.getByText("未找到符合本次范围的有效已发布知识；请补充资料或调整检索词"),
  ).toBeVisible();
  await page.getByRole("button", { name: "知识管理", exact: true }).click();
  await page.getByRole("button", { name: "修订知识", exact: true }).click();
  await page.getByLabel("知识正文", { exact: true }).fill("Synthetic 第二版待审核正文");
  await page.getByLabel("保存说明", { exact: true }).fill("Synthetic revision");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("最新草稿不会覆盖当前启用内容。", { exact: false })).toBeVisible();
  expect(
    (await centerApi<{ references: Array<{ version: number }> }>("knowledge/search", search))
      .references[0]?.version,
  ).toBe(1);
  await page.getByRole("combobox", { name: "查看版本", exact: true }).selectOption("1");
  await expect(
    page.getByText("抱枕 Listing 介绍定制照片上传流程；尺寸和材质引用已确认的商品规格。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "提交审核", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "查看最新版本", exact: true }).click();
  await expect(page.getByText("Synthetic 第二版待审核正文", { exact: true })).toBeVisible();
  await page.getByText("预览版本差异", { exact: true }).click();
  const diff = page.getByRole("region", { name: "知识版本差异", exact: true });
  await expect(diff).toContainText("V1 → V2");
  await expect(diff).toContainText("抱枕 Listing 介绍定制照片上传流程");
  await expect(diff).toContainText("Synthetic 第二版待审核正文");
  await page.screenshot({ path: testInfo.outputPath("knowledge-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "运营知识库", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("knowledge-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "打开全部导航", exact: true }).click();
  const mobileMenu = page.getByRole("dialog", { name: "全部导航", exact: true });
  await mobileMenu.getByRole("button", { name: "知识与规则", exact: true }).click();
  await expect(mobileMenu.getByRole("link", { name: "规则中心", exact: true })).toBeVisible();
  await mobileMenu.getByRole("button", { name: "关闭导航", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "提交审核", exact: true }).click();
  await page.getByLabel("操作说明", { exact: true }).fill("Synthetic revised knowledge review");
  await page.getByRole("button", { name: "确认提交审核", exact: true }).click();
  await page.getByRole("button", { name: "审核发布", exact: true }).click();
  const publication = page.getByRole("dialog", { name: "审核发布", exact: true });
  await expect(publication).toContainText("发布是更新 AI 使用的知识卡");
  await expect(
    publication.getByRole("region", { name: "知识版本差异", exact: true }),
  ).toContainText("V1 → V2");
  await page
    .getByLabel("操作说明", { exact: true })
    .fill("Synthetic differences and source verified");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "确认审核发布", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath("knowledge-publish-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "确认审核发布", exact: true }).click();
  await expect(page.getByText("已启用 V2。", { exact: true })).toBeVisible();
  expect(
    (
      await centerApi<{ references: Array<{ version: number }> }>("knowledge/search", {
        ...search,
        query: "Synthetic",
      })
    ).references[0]?.version,
  ).toBe(2);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "归档", exact: true }).click();
  await page.getByLabel("操作说明", { exact: true }).fill("Synthetic cleanup");
  await page.getByRole("button", { name: "确认归档", exact: true }).click();
  await expect
    .poll(async () => (await centerApi<KnowledgeWorkspace>("knowledge/workspace")).entries.length)
    .toBe(0);
  expect(
    (await centerApi<{ references: unknown[] }>("knowledge/search", search)).references,
  ).toEqual([]);
  // The runner removes and verifies the entire DB, including immutable synthetic history.
});

test("full knowledge workbench imports, governs, answers and evaluates real pinned tasks", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const fixture = await knowledgeGovernanceFixture();
  const library = () => centerApi<KnowledgeWorkspace>("knowledge/workspace");
  const governance = () => centerApi<KnowledgeGovernanceView>("knowledge-governance/workspace");
  const publishUi = async () => {
    await page.getByRole("button", { name: "提交审核", exact: true }).click();
    await page.getByLabel("操作说明", { exact: true }).fill("Synthetic reviewed import");
    await page.getByRole("button", { name: "确认提交审核", exact: true }).click();
    await page.getByRole("button", { name: "审核发布", exact: true }).click();
    await page.getByLabel("操作说明", { exact: true }).fill("Synthetic sources and scope checked");
    await page.getByRole("button", { name: "确认审核发布", exact: true }).click();
  };
  const publishApi = async (id: string) => {
    for (const action of ["submit", "publish"]) {
      const card = (await library()).entries.find((row) => row.id === id)!;
      await centerApi("knowledge/" + id + "/" + action, {
        expectedRevision: card.revision,
        version: card.latestVersion,
        reason: "Synthetic reviewed fixture",
        requestId: randomUUID(),
      });
    }
  };
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/knowledge?tab=imports");
    await page.getByRole("button", { name: "导入资料", exact: true }).click();
    const upload = page.getByRole("dialog", { name: "导入知识资料", exact: true });
    await upload.getByLabel("文件", { exact: true }).setInputFiles({
      name: "synthetic-operations.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("先核对资料，再保存。"),
    });
    await upload.getByLabel("资料标题", { exact: true }).fill("Synthetic operations");
    await upload.getByLabel("负责人", { exact: true }).fill("Synthetic operator");
    await upload.getByLabel("平台", { exact: true }).selectOption("amazon");
    await upload.getByLabel("站点", { exact: true }).fill("US");
    await upload.getByRole("button", { name: "上传并生成导入草稿", exact: true }).click();
    const original = page.getByRole("dialog", { name: "synthetic-operations.md", exact: true });
    await expect(original).toContainText("先核对资料，再保存。");
    await original.getByRole("button", { name: "编辑并确认候选卡", exact: true }).click();
    const candidate = page.getByRole("dialog", { name: "确认候选知识卡", exact: true });
    await candidate.getByLabel("资料标题", { exact: true }).fill("Synthetic SOP reviewed");
    await candidate
      .getByLabel("接受或拒绝依据", { exact: true })
      .fill("Synthetic source paragraph checked");
    await candidate.getByRole("button", { name: "确认入库为草稿", exact: true }).click();
    await expect(original).toContainText("已入库为草稿");
    await original.getByRole("button", { name: "关闭", exact: true }).click();
    const card = (await library()).entries.find(
      (row) => row.latest.title === "Synthetic SOP reviewed",
    )!;
    expect(card.activeVersion).toBeNull();
    expect(
      (
        await centerApi<{ references: unknown[] }>("knowledge/search", {
          query: "核对资料",
          topic: "all",
          platform: "amazon",
          market: "US",
          spuIds: [],
        })
      ).references,
    ).toEqual([]);
    await page.goto("/knowledge?entry=" + card.id);
    await publishUi();
    await expect(page.getByText("已启用 V1。", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "治理中心", exact: true }).click();
    await page.getByRole("button", { name: "覆盖矩阵", exact: true }).click();
    await expect(
      page.getByText("尚未定义知识需求，暂不计算覆盖率。", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "登记知识需求", exact: true }).click();
    const need = page.getByRole("dialog", { name: "登记知识需求", exact: true });
    await need.getByLabel("知识需求", { exact: true }).fill("核对资料流程");
    await need.getByLabel("负责人", { exact: true }).fill("Synthetic operator");
    await need.getByLabel("平台", { exact: true }).selectOption("amazon");
    await need.getByLabel("站点", { exact: true }).fill("US");
    await need.getByLabel("Synthetic SOP reviewed · 已启用 V1", { exact: true }).check();
    await need.getByRole("button", { name: "确认需求与关联", exact: true }).click();
    await expect(page.getByText("已覆盖 1 / 已确认需求 1", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "变更审核", exact: true }).click();
    await page.getByRole("button", { name: "登记官方来源", exact: true }).click();
    const sourceForm = page.getByRole("dialog", { name: "登记官方来源", exact: true });
    await sourceForm.getByLabel("来源名称", { exact: true }).fill("Synthetic official SOP");
    await sourceForm
      .getByLabel("公开 HTTPS 原文地址", { exact: true })
      .fill("https://example.com/synthetic-knowledge-sop");
    await sourceForm.getByLabel("负责人", { exact: true }).fill("Synthetic operator");
    await sourceForm.getByRole("button", { name: "保存来源", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "Synthetic official SOP", exact: true }),
    ).toBeVisible();
    const source = (await governance()).sources.find(
      (row) => row.label === "Synthetic official SOP",
    )!;
    const before = await fixture.sourceSnapshot(source.id, "先核对资料，再保存。");
    let latest = (await library()).entries.find((row) => row.id === card.id)!;
    await centerApi("knowledge/" + card.id + "/revise", {
      fields: {
        ...KnowledgeFieldsSchema.strip().parse(latest.latest),
        sourceSnapshotIds: [before.snapshotId!],
        claims: [
          {
            key: "synthetic.sop.review",
            value: "mandatory",
            unit: "",
            condition: "standard workflow",
            validFrom: latest.latest.verifiedOn,
            validUntil: latest.latest.reviewDueOn,
            severity: "blocking",
          },
        ],
      },
      expectedRevision: latest.revision,
      reason: "Synthetic provenance linked",
      requestId: randomUUID(),
    });
    await publishApi(card.id);
    const after = await fixture.sourceSnapshot(source.id, "先核对资料并保留复核记录。");
    await page.reload();
    await page.getByRole("button", { name: "治理中心", exact: true }).click();
    await page.getByRole("button", { name: "查看来源差异与审核", exact: true }).click();
    const review = page.getByRole("dialog", { name: "审核官方来源变更", exact: true });
    await expect(review).toContainText("先核对资料，再保存。");
    await expect(review).toContainText("先核对资料并保留复核记录。");
    await review.getByRole("link", { name: "编辑知识正文并关联本次来源证据", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "修订运营知识", exact: true });
    await editor.getByLabel("知识正文", { exact: true }).fill("先核对资料并保留复核记录。");
    await editor
      .getByLabel("保存说明", { exact: true })
      .fill("Synthetic official revision checked");
    await editor.getByRole("button", { name: "保存草稿", exact: true }).click();
    await publishUi();
    await expect(page.getByText("已启用 V3。", { exact: true })).toBeVisible();
    const reviewId = (await governance()).sourceReviews.find(
      (row) => row.afterSnapshotId === after.snapshotId,
    )!.id;
    await page.getByRole("button", { name: "治理中心", exact: true }).click();
    await page.getByRole("button", { name: "查看来源差异与审核", exact: true }).click();
    await review.getByLabel("审核决定", { exact: true }).selectOption("completed");
    await review
      .getByLabel("决定依据", { exact: true })
      .fill("Synthetic source change verified and V3 published");
    await review.getByRole("button", { name: "记录审核决定", exact: true }).click();
    await expect(review).toHaveCount(0);
    expect((await governance()).sourceReviews.find((row) => row.id === reviewId)?.state).toBe(
      "completed",
    );

    await page.getByRole("button", { name: "账户证据", exact: true }).click();
    await page.getByRole("button", { name: "导入资料", exact: true }).click();
    await upload.getByLabel("文件", { exact: true }).setInputFiles({
      name: "synthetic-report.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        "date,customer_name,email,api_key,revenue\n2026-10-01,Alice,alice@example.test,SYNTHETIC_SECRET,125.40",
      ),
    });
    await upload.getByLabel("资料标题", { exact: true }).fill("Synthetic account report");
    await upload.getByLabel("负责人", { exact: true }).fill("Synthetic operator");
    await upload.getByLabel("所属店铺", { exact: true }).selectOption(fixture.storeId);
    await upload.getByLabel("报告开始", { exact: true }).fill("2026-10-01");
    await upload.getByLabel("报告结束", { exact: true }).fill("2026-10-01");
    await upload.getByLabel("归因口径", { exact: true }).fill("Synthetic 7 day click attribution");
    await upload.getByRole("button", { name: "上传并生成导入草稿", exact: true }).click();
    const account = page.getByRole("dialog", { name: "synthetic-report.csv", exact: true });
    await expect(account).not.toContainText("SYNTHETIC_SECRET");
    await expect(account).not.toContainText("alice@example.test");
    await expect(account).not.toContainText("Alice");
    await expect(account).toContainText("125.40");
    await expect(account.getByRole("button", { name: "确认脱敏证据", exact: true })).toBeDisabled();
    for (const checkbox of await account.getByRole("checkbox").all()) await checkbox.check();
    await account
      .getByLabel("确认依据", { exact: true })
      .fill("Synthetic columns and store period reviewed");
    await account.getByRole("button", { name: "确认脱敏证据", exact: true }).click();
    await expect(account).toContainText("已确认的脱敏证据");
    await account.getByRole("button", { name: "关闭", exact: true }).click();

    await page.getByRole("button", { name: "知识对话", exact: true }).click();
    await page.getByLabel("已配置模型", { exact: true }).selectOption(fixture.modelId);
    await page.getByLabel("平台", { exact: true }).selectOption("amazon");
    await page.getByLabel("站点", { exact: true }).fill("US");
    await page.getByLabel("问题或追问", { exact: true }).fill("核对资料");
    const queued = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/ai-assists/runs") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "发送并检索知识", exact: true }).click();
    const runId = ((await (await queued).json()) as { id: string }).id;
    await fixture.answer(runId);
    await expect(page.locator(".kb-answer")).toContainText("已完成", { timeout: 20_000 });
    await expect(page.locator(".kb-answer")).toContainText("先核对资料并保留复核记录。");
    const answer = await centerApi<AssistView>("ai-assists/runs/" + runId);
    expect(answer.knowledge.find((ref) => ref.entryId === card.id)?.version).toBe(3);
    await page.locator(".kb-answer").getByText("本次固定引用（1）", { exact: true }).click();
    await page.screenshot({
      path: testInfo.outputPath("knowledge-dialogue-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("knowledge-dialogue-mobile.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.getByRole("button", { name: "治理中心", exact: true }).click();
    await page.getByRole("button", { name: "质量评测", exact: true }).click();
    await page.getByRole("button", { name: "新建评测问题", exact: true }).click();
    const evaluation = page.getByRole("dialog", { name: "新建评测问题", exact: true });
    await evaluation.getByLabel("问题名称", { exact: true }).fill("Synthetic fixed SOP answer");
    await evaluation.getByLabel("固定业务问题", { exact: true }).fill("核对资料");
    await evaluation.getByLabel("平台", { exact: true }).selectOption("amazon");
    await evaluation.getByLabel("站点", { exact: true }).fill("US");
    await evaluation.getByLabel("期望答案要点（每行一项）", { exact: true }).fill("保留复核记录");
    await evaluation.getByLabel("禁止出现的表述（每行一项）", { exact: true }).fill("保证销量");
    await evaluation.getByLabel("Synthetic SOP reviewed · 已启用 V3", { exact: true }).check();
    await evaluation.getByRole("button", { name: "保存固定问题", exact: true }).click();
    await page.getByLabel("回答评测模型", { exact: true }).selectOption(fixture.modelId);
    const evaluated = page.waitForResponse((response) =>
      /\/api\/knowledge-governance\/evaluations\/[^/]+\/start$/.test(response.url()),
    );
    await page.getByRole("button", { name: "运行回答评测", exact: true }).click();
    const evaluationId = ((await (await evaluated).json()) as { id: string }).id;
    let report = await centerApi<KnowledgeEvaluationReport>(
      "knowledge-governance/evaluation-runs/" + evaluationId,
    );
    await fixture.answer(report.answer.id);
    const results = page.getByRole("dialog", { name: "回答评测结果与版本对比", exact: true });
    await expect(results.locator(".kb-answer")).toContainText("已完成", { timeout: 20_000 });
    report = await centerApi<KnowledgeEvaluationReport>(
      "knowledge-governance/evaluation-runs/" + evaluationId,
    );
    expect(report.checks.filter((check) => check.status === "fail")).toEqual([]);
    await results.getByLabel("事实性人工核验", { exact: true }).selectOption("pass");
    await results
      .getByLabel("核验依据", { exact: true })
      .fill("Synthetic expected facts and citations checked against V3");
    await results.getByRole("button", { name: "记录人工核验", exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            await centerApi<KnowledgeEvaluationReport>(
              "knowledge-governance/evaluation-runs/" + evaluationId,
            )
          ).manualReviews.length,
      )
      .toBe(1);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("knowledge-evaluation-mobile.png"),
      fullPage: true,
    });
    await results.getByRole("button", { name: "关闭", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });

    latest = (await library()).entries.find((row) => row.id === card.id)!;
    const alternative = await centerApi<{ id: string }>("knowledge/create", {
      fields: {
        ...KnowledgeFieldsSchema.strip().parse(latest.latest),
        title: "Synthetic conditional alternative",
        claims: [
          {
            key: "synthetic.sop.review",
            value: "optional",
            unit: "",
            condition: "rush workflow",
            validFrom: latest.latest.verifiedOn,
            validUntil: latest.latest.reviewDueOn,
            severity: "blocking",
          },
        ],
      },
      expectedRevision: 0,
      reason: "Synthetic conflict acceptance",
      requestId: randomUUID(),
    });
    await page.reload();
    await page.getByRole("button", { name: "治理中心", exact: true }).click();
    await page.getByRole("button", { name: "冲突风险", exact: true }).click();
    await expect(page.getByText("synthetic.sop.review · 阻断级", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "人工裁决", exact: true }).click();
    const conflict = page.getByRole("dialog", { name: "人工裁决知识冲突", exact: true });
    await conflict.getByLabel("裁决", { exact: true }).selectOption("conditional");
    await conflict
      .getByLabel("裁决依据", { exact: true })
      .fill("Synthetic standard and rush conditions explicitly reviewed");
    await conflict.getByRole("button", { name: "确认裁决", exact: true }).click();
    await expect(page.getByText("已确认条件差异", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "时效监控", exact: true }).click();
    await expect(page.getByText("Synthetic official SOP", { exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("knowledge-governance-desktop.png"),
      fullPage: true,
    });

    // All synthetic resources, original bytes, model tasks and immutable history
    // live only in the runner's disposable DB, which its finally block removes.
    expect(alternative.id).toBeTruthy();
  } finally {
    await fixture.close();
  }
});

test("knowledge imports parse supported formats and reject unsafe or image-only input through real scanning", async ({
  page,
}) => {
  test.setTimeout(180000);
  const fields = KnowledgeFieldsSchema.parse({
    title: "Synthetic import boundary",
    summary: "Controlled import fixture",
    body: "Synthetic import data",
    topic: "operations",
    platform: "all",
    market: "ALL",
    spuId: null,
    sourceType: "team",
    sourceLabel: "Synthetic import source",
    sourceUrl: "",
    owner: "Synthetic operator",
    verifiedOn: "2026-01-01",
    reviewDueOn: "2099-12-31",
    tags: [],
  });
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic DOCX operating facts</w:t></w:r></w:p></w:body></w:document>',
  );
  const samples = [
    { name: "synthetic.txt", bytes: Buffer.from("Synthetic TXT operating facts"), text: "TXT" },
    {
      name: "synthetic.md",
      bytes: Buffer.from("# Synthetic MD\n\nApproved operating facts"),
      text: "Approved",
    },
    {
      name: "synthetic.csv",
      bytes: Buffer.from("topic,advice\noperations,Synthetic CSV operating facts"),
      text: "CSV",
    },
    {
      name: "synthetic.pdf",
      bytes: syntheticKnowledgePdf("Synthetic PDF operating facts"),
      text: "PDF",
    },
    {
      name: "synthetic.docx",
      bytes: await zip.generateAsync({ type: "nodebuffer" }),
      text: "DOCX",
    },
    { name: "synthetic-scan.pdf", bytes: syntheticKnowledgePdf(""), diagnostic: "OCR" },
    { name: "synthetic-corrupt.pdf", bytes: Buffer.from("not a PDF"), diagnostic: "PDF" },
    {
      name: "synthetic-encrypted.pdf",
      bytes: syntheticEncryptedKnowledgePdf,
      diagnostic: "密码",
    },
    {
      name: "synthetic-antivirus.txt",
      bytes: Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"),
      diagnostic: "安全扫描发现风险",
    },
  ];
  const created: string[] = [];
  try {
    const before = (await centerApi<KnowledgeWorkspace>("knowledge/workspace")).entries.map(
      (row) => row.id,
    );
    for (const sample of samples) {
      const result = await centerApi<{ id: string }>("knowledge-governance/documents/upload", {
        requestId: randomUUID(),
        fileName: sample.name,
        base64: sample.bytes.toString("base64"),
        fields,
        account: null,
        retentionDays: 7,
      });
      created.push(result.id);
      const document = await centerApi<KnowledgeDocumentView>(
        `knowledge-governance/documents/${result.id}`,
      );
      if ("text" in sample) {
        expect(document.state).not.toBe("failed");
        expect(document.hasOriginal).toBe(true);
        expect(
          document.candidates.some((candidate) => candidate.fields.body.includes(sample.text!)),
        ).toBe(true);
      } else {
        expect(document.state).toBe("failed");
        expect(document.candidates).toEqual([]);
        expect(document.diagnostics.some((value) => value.includes(sample.diagnostic!))).toBe(true);
        if (sample.name.endsWith("antivirus.txt")) expect(document.hasOriginal).toBe(false);
      }
    }
    expect(
      (await centerApi<KnowledgeWorkspace>("knowledge/workspace")).entries.map((row) => row.id),
    ).toEqual(before);
    const first = await centerApi<KnowledgeDocumentView>(
      `knowledge-governance/documents/${created[0]}`,
    );
    const original = await centerApi<{ base64: string }>(
      `knowledge-governance/documents/${first.id}/original`,
      {},
    );
    expect(Buffer.from(original.base64, "base64").equals(samples[0]!.bytes)).toBe(true);
    await centerApi(`knowledge-governance/documents/${first.id}/purge`, {});
    const purged = await centerApi<KnowledgeDocumentView>(
      `knowledge-governance/documents/${first.id}`,
    );
    expect(purged.hasOriginal).toBe(false);
    expect(purged.checksum).toBe(first.checksum);
    expect(purged.candidates.map((value) => value.id)).toEqual(
      first.candidates.map((value) => value.id),
    );
    await expect(
      centerApi(`knowledge-governance/documents/${first.id}/original`, {}),
    ).rejects.toThrow("HTTP 404");
    await page.goto(`/knowledge?tab=imports&document=${created.at(-1)}`);
    await expect(page.getByText(/资料安全扫描发现风险/).first()).toBeVisible();
  } finally {
    for (const id of created) await centerApi(`knowledge-governance/documents/${id}/archive`, {});
  }
});

function syntheticKnowledgePdf(text: string): Buffer {
  const stream = text ? `BT /F1 12 Tf 30 100 Td (${text}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let content = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const start = Buffer.byteLength(content);
  content +=
    "xref\n0 6\n0000000000 65535 f \n" +
    offsets.map((offset) => String(offset).padStart(10, "0") + " 00000 n \n").join("") +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(content);
}

// AES-256 synthetic document generated with ReportLab/pypdf; valid one-page text and render verified.
// SHA-256 ec94fea46bdd918eadf98fd7a592de6508fa389d1c273f4e6ccbff35b123b9e8
const syntheticEncryptedKnowledgePdf = Buffer.from(
  [
    "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDdmOGIwMTAyMDc5OGVkYzkxNTYwN2VkZWE3NmJiNTkyZTIwOTQy",
    "N2Q3NTkwZDVjZGRlYjI1MjMzMDc1ZWM1YWE+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lk",
    "cyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAg",
    "b2JqCjw8Ci9Db250ZW50cyA1IDAgUgovTWVkaWFCb3ggWyAwIDAgNjEyIDc5MiBdCi9SZXNvdXJjZXMgPDwKL0ZvbnQgNiAwIFIK",
    "L1Byb2NTZXQgWyAvUERGIC9UZXh0IC9JbWFnZUIgL0ltYWdlQyAvSW1hZ2VJIF0KPj4KL1JvdGF0ZSAwCi9UcmFucyA8PAo+Pgov",
    "VHlwZSAvUGFnZQovUGFyZW50IDIgMCBSCj4+CmVuZG9iago1IDAgb2JqCjw8Ci9GaWx0ZXIgWyAvQVNDSUk4NURlY29kZSAvRmxh",
    "dGVEZWNvZGUgXQovTGVuZ3RoIDI0MAo+PgpzdHJlYW0Kgwxp3Y/TcnrE/YKoX8wzLm0VR/7vWACHmNnmrf5dCPladNXZWGKTF7aX",
    "6Kc/j9ud1viEaN8O927yvfuIJqM245Cw9NGZkPyoITkoLzniNMXAdaZrKTCJzS/joFZdIFBUEl0eDvoRlgvzt1l2px/v7pFlrDJ1",
    "PCNnmPHyMtQ2PhpU1IPYp6Xdsg5UmN/zI8/gvGm8AfcjyvXAbIdHaeSnWpMZo/onTX7GjoGDGq7TMv4TI2HdV/MjZ/iv/M/42kaa",
    "Buv8l4IfG83pZEHj8pg87QYAsuhlGAjoKEXxKXHCdZ2FaKLIylu0+AKABja2ieVjCmVuZHN0cmVhbQplbmRvYmoKNiAwIG9iago8",
    "PAovRjEgNyAwIFIKPj4KZW5kb2JqCjcgMCBvYmoKPDwKL0Jhc2VGb250IC9IZWx2ZXRpY2EKL0VuY29kaW5nIC9XaW5BbnNpRW5j",
    "b2RpbmcKL05hbWUgL0YxCi9TdWJ0eXBlIC9UeXBlMQovVHlwZSAvRm9udAo+PgplbmRvYmoKOCAwIG9iago8PAovViA1Ci9SIDYK",
    "L0xlbmd0aCAyNTYKL1AgNDI5NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8ZmYwN2RhNDQzOTBhOWZhMTY0YjIwMzA3OWVh",
    "NjI2M2NmYzkxZWE4MmE3MmQxYjA3ZTNjNmExZmU4ZmY1YzAxMTNkYTM3YjZlOTk5N2FlZjM1MWJiYzdmNzI3MDlhNjQyPgovVSA8",
    "NDBiYTlkODcyMDcxNzVhNGI1ZGFjOGZjOGZhOGMyMjRlZDgxMDE4YjE5MzgyOWU4ZTZjNjUwZmZhOGQ0ODI2OTUyZWMxYzc3OTZi",
    "NzFmYjhkYzFmNTk0ZDUzNzVjZjljPgovQ0YgPDwKL1N0ZENGIDw8Ci9BdXRoRXZlbnQgL0RvY09wZW4KL0NGTSAvQUVTVjMKL0xl",
    "bmd0aCAzMgo+Pgo+PgovU3RtRiAvU3RkQ0YKL1N0ckYgL1N0ZENGCi9PRSA8NzQ2YTIyZWNhNDQ5Y2YyN2QwNjlmNTJjYmY0OTg1",
    "YmFiZWFmNDUxYWU4ZTdhOTA4MTFlY2VjOGExYTE1Yzc4MT4KL1VFIDw0NDI4MDM2M2UyYzgzMGVhZmY5NmUyNGU1ZmFiZWE5ZGVl",
    "YjMzYzQyMjk3OWI5MzcwNTg3YmRjYTIyNjNmNDA1PgovUGVybXMgPGYwYjZjMjJhMDAxMmY1M2IyOGM4OTM1ZDdmODc1Yjk0Pgo+",
    "PgplbmRvYmoKeHJlZgowIDkKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAxMTMgMDAwMDAg",
    "biAKMDAwMDAwMDE3MiAwMDAwMCBuIAowMDAwMDAwMjIxIDAwMDAwIG4gCjAwMDAwMDA0MTAgMDAwMDAgbiAKMDAwMDAwMDc0MSAw",
    "MDAwMCBuIAowMDAwMDAwNzcyIDAwMDAwIG4gCjAwMDAwMDA4NzkgMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSA5Ci9Sb290IDMg",
    "MCBSCi9JbmZvIDEgMCBSCi9JRCBbIDwzMjM1MzYzNjY0MzU2MzYxMzIzNzM4MzEzNzM4NjI2NjY2Mzc2NTY2MzgzNDMzMzk2NDM4",
    "MzQ2NjY0NjUzNDYzPiA8MzIzNTM2MzY2NDM1NjM2MTMyMzczODMxMzczODYyNjY2NjM3NjU2NjM4MzQzMzM5NjQzODM0NjY2NDY1",
    "MzQ2Mz4gXQovRW5jcnlwdCA4IDAgUgo+PgpzdGFydHhyZWYKMTQzNAolJUVPRgo=",
  ].join(""),
  "base64",
);
