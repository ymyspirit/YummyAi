import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { expect, test, type Locator } from "@playwright/test";
import { productVisualsFixture } from "./product-visuals-fixture";

test("controlled pillow visuals prepare, recover per image, review and synchronize a new real listing draft", async ({
  page,
}, info) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(20000);
  const fixture = await productVisualsFixture(),
    errors: string[] = [],
    submissions: Array<{ id: string; requestId: string }> = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const directory = new URL("../../../tmp/product-visuals-logs/", import.meta.url);
  mkdirSync(directory, { recursive: true });
  const proof: Record<string, unknown> = {
    fixtureIds: fixture.ids,
    transport: "controlled synthetic PNG; no provider network calls",
    realPaidCalls: 0,
    marketplaceWrites: 0,
    productionRelease: false,
  };
  const persist = () =>
    writeFileSync(
      new URL(`browser-${fixture.planId}.json`, directory),
      JSON.stringify(
        {
          ...proof,
          syntheticModelCalls: fixture.calls,
          submissions,
          pageErrors: errors,
          cleanup: "all fixture resources owned by isolated runner",
        },
        null,
        2,
      ),
    );
  const region = page.getByRole("region", { name: "抱枕图稿与套图交付", exact: true });
  const slot = (name: string) => region.getByRole("region", { name, exact: true });
  async function generate(name: string) {
    const response = page.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/generate"),
    );
    await slot(name)
      .getByRole("button", { name: /生成.*候选/ })
      .click();
    const returned = await response;
    expect(returned.ok(), `Generate ${name}: ${returned.status()}`).toBe(true);
    const result = (await returned.json()) as { id: string };
    const payload = returned.request().postDataJSON() as { requestId: string };
    submissions.push({ ...result, requestId: payload.requestId });
    await expect(region.getByRole("status")).toContainText("已提交");
    return result.id;
  }
  async function collect() {
    await region.getByRole("button", { name: "刷新视觉进度", exact: true }).click();
    await expect(region.getByRole("button", { name: "读取已完成结果", exact: true })).toBeVisible();
    await region.getByRole("button", { name: "读取已完成结果", exact: true }).click();
    await expect(region.getByRole("status")).toContainText("已登记");
  }
  async function approve(target: Locator) {
    const candidate = target
      .locator(".pv-result")
      .filter({ has: page.getByRole("button", { name: "通过此版本", exact: true }) })
      .first();
    expect(
      await candidate.getByRole("button", { name: "通过此版本", exact: true }).isDisabled(),
    ).toBe(true);
    for (const checkbox of await candidate.getByRole("checkbox").all()) await checkbox.check();
    await candidate.getByRole("button", { name: "通过此版本", exact: true }).click();
    await expect(region.getByRole("status")).toContainText("审核通过");
  }
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/sales-plans?plan=${fixture.planId}&view=tasks#product-visuals`);
    await expect(region).toBeVisible();
    await expect(region.getByLabel("真实样品图")).toBeVisible();
    await region.getByLabel("真实样品图").selectOption(fixture.sample);
    await region
      .getByLabel("样品核对依据")
      .fill("Synthetic owned sample; same contour, single printed front and white back");
    await region
      .getByRole("combobox", { name: "图像模型", exact: true })
      .selectOption(fixture.modelId);
    await region.getByLabel("请求图片尺寸").selectOption("1024x1024");
    await region.getByLabel("单次预算占用（USD）").fill("0.1");
    await region.getByLabel("本交付总预算（USD）").fill("0.6");
    await region.getByRole("checkbox", { name: /已核对所选模型/ }).check();
    await region.getByRole("button", { name: "固定视觉需求", exact: true }).click();
    await expect(region.getByRole("status")).toContainText("视觉需求已固定");
    expect(fixture.calls).toBe(0);
    const workspace = await fixture.workspace(),
      group = workspace.projects[0]!.id;
    fixture.ids.groups.push(group);
    expect(workspace.projects[0]!.tasks).toHaveLength(0);
    expect(
      await slot("场景图")
        .getByRole("button", { name: /生成一张候选/ })
        .isDisabled(),
    ).toBe(true);

    // Response loss after the server accepted the first request must replay its UUID.
    let loseResponse = true;
    await page.route(
      `**/api/sales-plans/${fixture.planId}/launch/visuals/${group}/generate`,
      async (route) => {
        if (loseResponse) {
          loseResponse = false;
          const accepted = await route.fetch();
          expect(accepted.ok()).toBe(true);
          proof.lostResponseRequest = route.request().postDataJSON();
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ message: "Synthetic response lost after acceptance" }),
          });
        } else await route.continue();
      },
    );
    await slot("图稿候选")
      .getByRole("button", { name: /生成一张候选/ })
      .click();
    await expect(region.getByRole("alert")).toContainText("Synthetic response lost");
    const art = await generate("图稿候选");
    expect((proof.lostResponseRequest as { requestId: string }).requestId).toBe(
      submissions[0]!.requestId,
    );
    expect((await fixture.workspace()).projects[0]!.budget.occupiedUsd).toBe(0.1);
    await fixture.process(art);
    await fixture.process(art);
    expect(fixture.calls).toBe(1);
    await collect();
    await approve(slot("图稿候选"));
    const artVersion = (await fixture.workspace()).projects[0]!.tasks.find((t) => t.id === art)!
      .result!.versionId;
    await region.getByLabel("套图使用的已审核图稿").selectOption(artVersion);
    const broken = await generate("场景图");
    await fixture.process(broken, "provider").catch(() => undefined);
    await region.getByRole("button", { name: "刷新视觉进度", exact: true }).click();
    await expect(slot("场景图")).toContainText("制作失败");
    const calls = fixture.calls;
    await page.reload();
    await expect(region.getByLabel("视觉交付预算")).toContainText("0.2000");
    expect(fixture.calls).toBe(calls);
    await region.getByLabel("套图使用的已审核图稿").selectOption(artVersion);
    const scene = await generate("场景图");
    await fixture.process(scene);
    await collect();
    await approve(slot("场景图"));
    for (const name of ["细节图", "定制说明图"]) {
      const id = await generate(name);
      await fixture.process(id);
      await collect();
      await approve(slot(name));
    }
    expect(fixture.calls).toBe(5);
    const state = await fixture.workspace();
    expect(state.projects[0]!.budget).toMatchObject({
      occupiedUsd: 0.5,
      remainingUsd: 0.1,
      actualUsd: null,
    });
    await expect(region.getByLabel("视觉交付预算")).toContainText("实际账单待确认");
    for (const name of ["场景图", "细节图", "定制说明图"])
      await slot(name).getByRole("radio", { name: "选为本槽位刊登配图", exact: true }).check();
    await region
      .getByRole("checkbox", { name: "明确使用本次核对的真实样品图作为主图", exact: true })
      .check();
    await region.getByRole("button", { name: "采纳三个套图槽位", exact: true }).click();
    await expect(region).toContainText("已采纳到方案 V2");
    const detail = await fixture.detail();
    expect(detail.plan.fields.mainImageId).toBe(fixture.sample);
    expect(detail.plan.fields.mediaAssetIds).toHaveLength(4);
    await region.getByRole("button", { name: "同步刊登草稿", exact: true }).click();
    await expect(region.getByRole("status")).toContainText("新的刊登草稿版本");
    const draft = await fixture.detail();
    expect(draft.listings).toHaveLength(1);
    fixture.ids.listings.push(draft.listings[0]!.id);
    proof.listing = draft.listings[0];
    // Synchronizing the same plan again creates a new immutable draft, not a seller action.
    await region.getByRole("button", { name: "同步刊登草稿", exact: true }).click();
    await expect(region.getByRole("status")).toContainText("新的刊登草稿版本");
    const second = await fixture.detail();
    expect(second.listings[0]!.version).toBe(draft.listings[0]!.version + 1);
    expect(second.listings[0]!.planRevision).toBe(2);
    expect(fixture.calls).toBe(5);
    for (const [name, width, dark] of [
      ["desktop", 1440, false],
      ["mobile", 390, false],
      ["mobile-dark", 390, true],
    ] as const) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate((dark) => {
        document.documentElement.dataset.theme = dark ? "dark" : "light";
      }, dark);
      await region.scrollIntoViewIfNeeded();
      await region.screenshot({ path: info.outputPath(`product-visuals-region-${name}.png`) });
      await page.screenshot({
        path: info.outputPath(`product-visuals-${name}.png`),
        fullPage: true,
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${name} overflow`,
      ).toBe(true);
    }
    expect(errors).toEqual([]);
    proof.planRevision = second.plan.revision;
    proof.recoveryReplayPassed = true;
    if (process.env.VISUAL_LIGHTHOUSE_CLI) {
      const report = info.outputPath("product-visuals-lighthouse.json");
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            process.env.VISUAL_LIGHTHOUSE_CLI!,
            `http://localhost:3100/sales-plans?plan=${fixture.planId}&view=tasks`,
            "--chrome-flags=--headless --no-sandbox",
            "--only-categories=performance,accessibility,best-practices,seo",
            "--quiet",
            "--output=json",
            `--output-path=${report}`,
          ],
          { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
        );
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("Lighthouse did not finish within its bounded QA window"));
        }, 60000);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`Lighthouse exited ${code}`));
        });
        child.stderr?.resume();
      });
      const reportData = JSON.parse(readFileSync(report, "utf8")) as {
        categories: Record<string, { score: number }>;
        audits: Record<string, { score: number | null }>;
      };
      proof.lighthouse = {
        scores: Object.fromEntries(
          Object.entries(reportData.categories).map(([key, value]) => [key, value.score * 100]),
        ),
        failedAudits: Object.entries(reportData.audits)
          .filter(([, value]) => value.score !== null && value.score < 1)
          .map(([key]) => key),
        runtime: "development server; no production performance claim",
      };
    }
  } finally {
    persist();
    await fixture.close();
  }
});
