import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { apiFetch } from "../src/server-api";

test("advertising workbench imports source reports and closes the human review loop", async ({
  page,
}) => {
  test.setTimeout(180000);
  const guard = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
  if (
    process.env.E2E_ISOLATED_DAILY !== "1" ||
    !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(guard.pathname)
  )
    throw new Error("Disposable advertising fixture required");
  const response = await apiFetch(`${process.env.API_BASE_URL}/v1/marketplace-accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      platform: "amazon",
      displayName: "Synthetic advertising shop",
      region: "NA",
      authorizationMode: "amazon_private",
      marketplaceIds: ["ATVPDKIKX0DER", "A2EUQ1WTGCTBG2"],
      requestedScopes: [],
    }),
  });
  expect(response.ok).toBe(true);
  const account = (await response.json()) as { id: string };
  const headers =
    "日期范围,广告主账户 ID,广告产品,广告活动编号,广告组编号,预算货币,展示量,点击量,购买量,总成本,销售额";
  const period = "2026年09月01日 - 2026年09月15日",
    row = `${period},advertiser,SP,campaign,group,USD,1000,40,4,10,40`;
  const files = [
    {
      name: "SP_Campaign.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        `${headers}\n${row}\n${period},advertiser-ca,SD,ca-campaign,ca-group,CAD,500,10,2,3,15`,
      ),
    },
    {
      name: "SP_Advertised_product.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(`${headers},推广的商品编号\n${row},B012345678`),
    },
    {
      name: "SP_Targeting.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        `${headers},投放方案编号,投放方案,目标竞价,投放状态\n${row},target,custom pillow,1,ENABLED`,
      ),
    },
    {
      name: "SP_Search_term.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        `${headers},搜索词\n${period},advertiser,SP,campaign,group,USD,500,20,0,10,0,cheap filler\n${period},advertiser,SP,campaign,group,USD,500,20,4,0,40,custom pillow`,
      ),
    },
  ];
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/customer-intelligence?account=${account.id}`);
  await expect(page.getByRole("heading", { name: "广告与 VOC", exact: true })).toBeVisible();
  await expect(
    page.getByText("先导入每日下载的广告报表，再设置每个产品的目标。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "导入历史", exact: true }).click();
  await page.getByLabel("选择 CSV 文件", { exact: true }).setInputFiles(files);
  await page.getByLabel("归因天数（未知则留空）").fill("7");
  await page.getByLabel("归因方式", { exact: true }).selectOption("click");
  await page.getByLabel("缺失站点时的明确映射").fill("USD=US\nCAD=CA");
  await page.getByRole("button", { name: "解析并预览", exact: true }).click();
  await expect(page.getByRole("region", { name: "导入预览" })).toBeVisible();
  await page.getByRole("button", { name: "确认导入已预览报表", exact: true }).click();
  await expect(
    page.getByText("4 份报表已导入，运行分析后查看产品目标与诊断", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "运行分析", exact: true }).click();
  await page.getByRole("button", { name: "产品目标", exact: true }).click();
  await page.getByRole("button", { name: "查看 B012345678 目标", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "广告证据与处理" });
  await drawer.getByLabel("生效日期", { exact: true }).fill("2026-09-01");
  await drawer.getByLabel("目标 ACoS (%)", { exact: true }).fill("21");
  await drawer.getByLabel("单件售价 (USD)", { exact: true }).fill("100");
  await drawer.getByLabel("单件广告前总成本 (USD)", { exact: true }).fill("70");
  await drawer
    .getByLabel("成本来源与目标说明")
    .fill("Synthetic confirmed period costs, no real marketplace data");
  await drawer.getByRole("button", { name: "保存目标版本", exact: true }).click();
  await expect(
    page.getByText("已保存；重新分析可查看新目标或新证据的结果", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭广告详情", exact: true }).click();
  await page.getByRole("button", { name: "运行分析", exact: true }).click();
  await page.getByRole("button", { name: "每日复盘", exact: true }).click();
  await expect(page.getByText("保利润 · V1", { exact: true })).toBeVisible();
  await expect(page.getByText("经营数据待补充", { exact: true })).toBeVisible();
  await expect(page.getByText("CA · CAD · SD", { exact: true })).toBeVisible();
  await expect(page.getByText("US · USD · SP", { exact: true })).toBeVisible();
  await expect(
    page.getByText("本次控制表只有区间汇总，或缺少可用日报；补充同口径日报后展示真实日趋势。", {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: fileURLToPath(new URL("../../../tmp/advertising-e2e/desktop.png", import.meta.url)),
    fullPage: true,
  });
  await page.getByRole("button", { name: /小幅降低竞价候选/ }).click();
  await drawer.getByLabel("处理原因", { exact: true }).fill("核对目标与成熟样本后采纳受限减费试验");
  await drawer.getByRole("button", { name: "保存处理记录", exact: true }).click();
  await expect(drawer.getByLabel("实际执行时间", { exact: true })).toBeVisible();
  // The operator input records whole seconds; wait until that second is after
  // the newly generated candidate instead of backdating the fixture by truncation.
  const nextExecutionSecond = Math.ceil(Date.now() / 1000) * 1000;
  await expect.poll(() => Date.now()).toBeGreaterThanOrEqual(nextExecutionSecond);
  const executedAt = await page.evaluate(() =>
    new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19),
  );
  await drawer.getByLabel("实际执行时间", { exact: true }).fill(executedAt);
  await drawer
    .getByLabel("处理原因", { exact: true })
    .fill("Synthetic manual bid changed 1.00 to 0.85 after checking target ID");
  await drawer.getByRole("button", { name: "保存处理记录", exact: true }).click();
  await expect(drawer.getByLabel("记录处理结果")).toHaveValue("observing");
  await drawer.getByLabel("处理原因", { exact: true }).fill("进入观察期，等待同口径新报表");
  await drawer.getByRole("button", { name: "保存处理记录", exact: true }).click();
  await expect(drawer.getByLabel("记录处理结果")).toHaveValue("reviewed");
  await expect(drawer.getByRole("button", { name: "保存处理记录", exact: true })).toBeDisabled();
  await expect(drawer.getByText(/观察期截至/)).toBeVisible();
  await page.getByRole("button", { name: "关闭广告详情", exact: true }).click();
  await page.getByRole("button", { name: /^调整与复盘/ }).click();
  await page.getByRole("button", { name: "封存已审阅清单", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "下载不可变审阅包（JSON）", exact: true }),
  ).toBeVisible();
  const exported = await page.request.get(
    (await page
      .getByRole("link", { name: "下载不可变审阅包（JSON）", exact: true })
      .getAttribute("href")) ?? "",
  );
  expect(exported.ok()).toBe(true);
  const sealed = await exported.json();
  expect(
    sealed.payload.actions.some((a: { actualAfterMinor: number }) => a.actualAfterMinor === 85),
  ).toBe(true);
  expect(sealed.payload.sourcePins).toHaveLength(4);
  const checklist = await page.request.get(
    (await page
      .getByRole("link", { name: "下载人工调整清单（CSV）", exact: true })
      .getAttribute("href")) ?? "",
  );
  expect(checklist.ok()).toBe(true);
  expect(checklist.headers()["content-type"]).toContain("text/csv");
  expect(await checklist.text()).toContain("实际执行投放ID");
  await page.getByRole("button", { name: "产品目标", exact: true }).click();
  await page.getByRole("button", { name: "查看 B012345678 目标", exact: true }).click();
  await drawer.getByLabel("产品目标", { exact: true }).selectOption("rank_growth");
  await drawer.getByLabel("核心关键词（每行一个）", { exact: true }).fill("custom pillow");
  await drawer.getByLabel("试验结束日期", { exact: true }).fill("2026-10-30");
  await drawer.getByLabel("试验花费上限 (USD)", { exact: true }).fill("50");
  await drawer.getByRole("button", { name: "保存目标版本", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "保存目标版本", exact: true })).toBeEnabled();
  await expect(
    page.getByText("已保存；重新分析可查看新目标或新证据的结果", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭广告详情", exact: true }).click();
  await page.getByRole("button", { name: "运行分析", exact: true }).click();
  await expect(page.getByText("推排名 · V2", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByText("推排名 · V2", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await page.screenshot({
    path: fileURLToPath(
      new URL("../../../tmp/advertising-e2e/mobile-overview.png", import.meta.url),
    ),
    fullPage: true,
  });
  await page.getByRole("button", { name: "查看 B012345678 目标", exact: true }).click();
  await expect(drawer).toBeVisible();
  expect(await drawer.evaluate((el) => el.getBoundingClientRect().top)).toBeCloseTo(0, 0);
  await expect(page.getByRole("button", { name: "关闭广告详情", exact: true })).toBeFocused();
  expect(await drawer.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({
    path: fileURLToPath(new URL("../../../tmp/advertising-e2e/mobile.png", import.meta.url)),
    fullPage: false,
  });
  await page.getByRole("button", { name: "关闭广告详情", exact: true }).click();
  await page.getByRole("button", { name: "搜索词与投放", exact: true }).click();
  await page.getByLabel("搜索词、ASIN、活动或投放 ID").fill("cheap");
  await expect(page.getByRole("table", { name: "广告来源明细" })).toContainText("cheap filler");
  expect(new URL(page.url()).searchParams.get("search")).toBe("cheap");
  await page.reload();
  await expect(page.getByLabel("搜索词、ASIN、活动或投放 ID")).toHaveValue("cheap");
  await page.getByRole("button", { name: "VOC", exact: true }).click();
  await expect(page.getByText("还没有广告或客户信号证据", { exact: true })).toBeVisible();
  const workspace = await apiFetch(`${process.env.API_BASE_URL}/v1/advertising/workspace`);
  expect(workspace.ok).toBe(true);
  const state = await workspace.json();
  await mkdir(new URL("../../../tmp/advertising-e2e/", import.meta.url), { recursive: true });
  await writeFile(
    new URL("../../../tmp/advertising-e2e/fixture-ids.json", import.meta.url),
    JSON.stringify(
      {
        accountId: account.id,
        importIds: state.imports.map((i: { id: string }) => i.id),
        goalIds: state.goals.map((g: { id: string }) => g.id),
        actionIds: state.actions.map((a: { id: string }) => a.id),
        exportId: sealed.id,
        disposal: "owned runner destroys database, bucket and Redis in finally",
      },
      null,
      2,
    ),
  );
  const retainedResponse = await apiFetch(`${process.env.API_BASE_URL}/v1/marketplace-accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "amazon", displayName: "Retained synthetic shop", region: "NA", authorizationMode: "amazon_private", marketplaceIds: ["ATVPDKIKX0DER"], requestedScopes: [] }),
  });
  expect(retainedResponse.ok).toBe(true);
  const retainedAccount = await retainedResponse.json();
  const removal = await apiFetch(`${process.env.API_BASE_URL}/v1/marketplace-accounts/${account.id}`, { method: "DELETE" });
  expect(removal.ok).toBe(true);
  await page.goto(`/customer-intelligence?account=${retainedAccount.id}`);
  await expect(page.getByLabel("广告店铺", { exact: true })).toHaveValue(retainedAccount.id);
  await expect(page.getByLabel("广告店铺", { exact: true }).locator("option")).toHaveText(["选择 Amazon 店铺", "Retained synthetic shop"]);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/stores");
  await expect(page.getByText("Retained synthetic shop", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Synthetic advertising shop", { exact: true })).toHaveCount(0);
});
