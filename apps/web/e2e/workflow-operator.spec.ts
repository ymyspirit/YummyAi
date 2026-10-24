import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { WorkflowRunDetail } from "@yummyai/contracts/workflow";
import type { WorkflowNodeInspection } from "@yummyai/contracts/workflow/operator";
import { inspectCustomProductPackage } from "@yummyai/storage";
import { Permission } from "../../../packages/authz/src/index";
import { workflowApi, workflowOperatorFixture } from "./workflow-operator-fixture";

test("operator repairs a failed node, keeps a note through real execution and downloads its owned ZIP", async ({
  page,
}, testInfo) => {
  const fixture = await workflowOperatorFixture(),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const source = await fixture.source(),
      run = await fixture.run();
    expect(run.status).toBe("failed");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/workflows/runs/${run.id}?node=execute`);
    await expect(page.getByRole("heading", { name: "整理商品事实", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "沿用原输入重试", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "重新配置输入", exact: true }).click();
    await page
      .getByRole("combobox", { name: "研究快照", exact: true })
      .selectOption(source.snapshotId);
    await page.getByLabel("目标站点", { exact: true }).fill("amazon.com");
    await page.getByRole("button", { name: "按新输入重新排队", exact: true }).click();
    await expect(page.getByText("已保存 等待派发", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("textbox", { name: "任务说明", exact: true })).toBeEnabled();
    await page
      .getByRole("textbox", { name: "任务说明", exact: true })
      .fill("保留这段未保存的商品核对说明");
    await fixture.startWorker();
    await expect
      .poll(
        async () => (await workflowApi<WorkflowRunDetail>(`workflow-runs/${run.id}`)).currentNodeId,
        { timeout: 20_000 },
      )
      .toBe("review");
    await expect(page.getByText("流程已更新 你的文字仍保留", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("textbox", { name: "任务说明", exact: true })).toHaveValue(
      "保留这段未保存的商品核对说明",
    );
    await expect(page.getByRole("button", { name: "保存说明", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "保留文字继续编辑", exact: true }).click();
    await page.getByRole("button", { name: "保存说明", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await workflowApi<WorkflowRunDetail>(`workflow-runs/${run.id}`)).nodes.find(
            (node) => node.nodeId === "execute",
          )?.note,
      )
      .toBe("保留这段未保存的商品核对说明");
    const invocation=page.locator(".wf-attempt-history > li").first().getByRole("region",{name:"调用与费用记录",exact:true});
    await invocation.getByRole("button",{name:"调用与费用记录",exact:true}).click();
    await expect(invocation.getByText("已核对业务回执",{exact:false})).toBeVisible();
    const traceDownloadEvent=page.waitForEvent("download");await invocation.getByRole("button",{name:"下载核对记录",exact:true}).click();
    const traceDownload=await traceDownloadEvent,tracePath=testInfo.outputPath("workflow-execution-evidence.json");await traceDownload.saveAs(tracePath);
    expect(JSON.parse(await readFile(tracePath,"utf8"))).toMatchObject({providerInvoiceVerified:false,invocations:[{owner:"workflow",boundary:"owner_receipt",artifact:{kind:"owner_receipt"},billing:{basis:"not_applicable",amountUsd:null}}]});
    await page.getByRole("button", { name: "核对产物", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "本次生成的商品事实", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("operator-desktop.png"), fullPage: true });
    await page.reload();
    await expect(page.getByRole("heading", { name: "整理商品事实", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "当前任务", exact: true }).click();
    await expect(page.getByRole("button", { name: "批准", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "批准", exact: true }).click();
    await expect
      .poll(async () => (await workflowApi<WorkflowRunDetail>(`workflow-runs/${run.id}`)).status, {
        timeout: 20_000,
      })
      .toBe("completed");
    await page.getByRole("button", { name: "列表", exact: true }).click();
    await page.getByRole("button", { name: /打开任务.*导出产品包/ }).click();
    await page.getByRole("button", { name: "核对产物", exact: true }).click();
    await expect(page.getByLabel("产品包待核对项", { exact: true })).toBeVisible();
    await expect(page.getByLabel("产品包待核对项", { exact: true })).toContainText(
      "请明确商品类型",
    );
    const downloading = page.waitForEvent("download");
    await page.getByRole("link", { name: "下载产品包", exact: true }).click();
    const download = await downloading,
      path = testInfo.outputPath("synthetic-custom-product.zip");
    await download.saveAs(path);
    const bytes = await readFile(path),
      inspected = await inspectCustomProductPackage(bytes);
    expect(inspected.manifest.mode).toBe("draft");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    await expect(page.getByText(`SHA-256 ${checksum}`, { exact: true })).toBeVisible();
    const artifactButton = page.getByRole("button", { name: "核对产物", exact: true });
    await artifactButton.focus();
    await artifactButton.press("Enter");
    await expect(artifactButton).toHaveAttribute("aria-expanded", "false");
    await artifactButton.press("Enter");
    await expect(page.getByRole("link", { name: "下载产品包", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      )
      .toBe(true);
    await page.getByRole("button", { name: "深色", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({
      path: testInfo.outputPath("operator-tablet-dark.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      )
      .toBe(true);
    await expect(page.getByRole("link", { name: "下载产品包", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("operator-phone.png"), fullPage: true });
    expect(errors).toEqual([]);
    await testInfo.attach("execution-proof", {
      body: JSON.stringify({ runId: run.id, sha256: checksum, ...fixture.proof() }, null, 2),
      contentType: "application/json",
    });
  } finally {
    await fixture.close();
  }
});

test("read-only members see actual records and permission revocation clears the operator view", async ({
  page,
}) => {
  const fixture = await workflowOperatorFixture();
  const commands: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") commands.push(request.url());
  });
  try {
    const run = await fixture.run();
    await fixture.permissions([
      Permission.WorkflowRead,
      Permission.ProductRead,
      Permission.ResearchRead,
    ]);
    await page.goto(`/workflows/runs/${run.id}?node=execute`);
    await expect(page.getByText("当前成员可查看记录 暂无操作权限", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "任务说明", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "沿用原输入重试", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "重新配置输入", exact: true })).toHaveCount(0);
    await fixture.permissions([Permission.ProductRead]);
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(page.getByRole("heading", { name: "任务暂不可查看", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "任务说明", exact: true })).toHaveCount(0);
    expect(commands).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("POD repair uses actual inputs and an uncertain child stays linked without replacement controls", async ({
  page,
}, testInfo) => {
  const fixture = await workflowOperatorFixture(),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const product = await fixture.podProduct();
    const run = await fixture.run(
      "pod.pattern_crop",
      {
        skuId: product.skuId,
        inputAssetIds: [product.assetId],
        parameterSnapshot: {
          mode: "general",
          multiCrop: false,
          maximumCropsPerInput: 1,
          outputFormat: "png",
          background: "preserved",
          perspectiveCorrection: true,
          cropPaddingPercent: 25,
        },
      },
      product.productPlanId,
      false,
    );
    expect(run.status).toBe("failed");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/workflows/runs/${run.id}?node=execute`);
    await page.getByRole("button", { name: "重新配置输入", exact: true }).click();
    await page.getByRole("combobox", { name: "关联 SKU", exact: true }).selectOption(product.skuId);
    await page.locator(`input[name="inputAssetIds"][value="${product.assetId}"]`).check();
    await page.getByLabel("裁剪留白 %", { exact: true }).fill("4");
    await page.getByLabel("每张图最多裁剪数", { exact: true }).fill("1");
    await page.getByLabel("同一输入识别多个图案", { exact: true }).uncheck();
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      )
      .toBe(true);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({
      path: testInfo.outputPath("operator-pod-repair-phone.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "按新输入重新排队", exact: true }).click();
    await fixture.startWorker();
    await expect
      .poll(
        async () =>
          (
            await workflowApi<WorkflowNodeInspection>(
              `workflow-runs/${run.id}/nodes/execute/execution`,
            )
          ).attempts[0]?.child?.id,
        { timeout: 20_000 },
      )
      .toBeTruthy();
    const inspection = await workflowApi<WorkflowNodeInspection>(
        `workflow-runs/${run.id}/nodes/execute/execution`,
      ),
      attempt = inspection.attempts[0]!;
    await fixture.uncertain(attempt.child!.id, attempt.id);
    await expect(
      page.getByText("原请求的结果或费用尚未确定 请核对原任务后处理", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "重新配置输入", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "沿用原输入重试", exact: true })).toBeDisabled();
    await page.getByRole("link", { name: "核对原 POD 任务", exact: true }).click();
    const original = page.locator(`#pod-task-${attempt.child!.id}`);
    await expect(original).toBeVisible();
    await expect(original).toContainText("原请求的结果或费用尚未确定");
    await expect(original).toHaveAttribute("aria-current", "true");
    const invocation=original.getByRole("region",{name:"调用与费用记录",exact:true});
    await invocation.getByRole("button",{name:"调用与费用记录",exact:true}).click();
    await expect(invocation.getByText("已记录提交边界",{exact:false})).toBeVisible();
    await expect(invocation).toContainText(/派发\s*1\s*次/);
    await expect(invocation.getByText("原报告缺少费用依据 未补证时不按零费用处理",{exact:true})).toBeVisible();
    expect((await invocation.locator("dd").first().boundingBox())!.width).toBeGreaterThan(130);
    expect((await invocation.boundingBox())!.height).toBeLessThan(850);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:testInfo.outputPath("pod-invocation-phone.png"),fullPage:true});
    expect(fixture.proof().syntheticPodCalls).toBe(1);
    expect(errors).toEqual([]);
    await testInfo.attach("pod-proof", {
      body: JSON.stringify(fixture.proof(), null, 2),
      contentType: "application/json",
    });
  } finally {
    await fixture.close();
  }
});
