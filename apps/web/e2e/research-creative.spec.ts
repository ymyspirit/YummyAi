import { expect, test, type Route } from "@playwright/test";
import { CaptureDraftSchema } from "@yummyai/contracts";
import type { CanvasBrief } from "@yummyai/contracts/pod/canvas-bridge";
import type {
  ResearchStudyRevision,
  ResearchStudyWorkspace,
} from "@yummyai/contracts/research/creative";
import { centerApi } from "./order-centers-fixture";
import { syntheticProductionPng } from "./production-editor-fixture";
import { researchMediaFixture } from "./research-media-fixture";

test("competitor gallery, study annotations and bulk creative requirements preserve their versions", async ({
  page,
}, testInfo) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(20000);
  const suffix = crypto.randomUUID().slice(0, 8),
    id = String(Date.now());
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const mediaFixture = await researchMediaFixture();
  try {
    const image = syntheticProductionPng();
    mediaFixture.register("https://i.etsystatic.com/synthetic/one.png", image);
    mediaFixture.register("https://i.etsystatic.com/synthetic/two.png", image);
    await mediaFixture.startWorker();
    let imagesAvailable = false;
    await page
      .context()
      .route(/\/api\/capture-media\/[^/?]+\/[^/?]+(?:\?.*)?$/, (route) =>
        imagesAvailable ? route.continue() : route.abort(),
      );
    const captureInput = (externalId: string, title: string, time = new Date().toISOString()) =>
      CaptureDraftSchema.parse({
        platform: "etsy",
        parserVersion: "etsy@1.0.0",
        extensionVersion: "0.0.0",
        marketplace: "www.etsy.com",
        sourceUrl: `https://www.etsy.com/listing/${externalId}/synthetic`,
        externalId,
        title,
        domain: "research",
        capturedAt: time,
        price: { raw: "$20", amount: 20, currency: "USD" },
        rating: null,
        reviewCount: null,
        taxonomy: [],
        listingPublishedAt: null,
        favoriteCount: null,
        shipping: null,
        shop: null,
        reviewSummary: null,
        reviews: [],
        reviewCollection: {
          collectedCount: 0,
          reportedTotal: null,
          pageCount: 0,
          status: "visible",
          updatedAt: time,
        },
        bullets: [],
        variants: [],
        productInformation: [],
        contentBlocks: [
          {
            kind: "personalization",
            text: "Synthetic name customization, up to 20 characters",
            sourceSelector: "#synthetic-personalization",
          },
        ],
        missingFields: [],
        diagnostics: [],
        captureStatus: "complete",
        media: [
          {
            id: "one",
            kind: "image",
            sourceUrl: "https://i.etsystatic.com/synthetic/one.png",
            included: true,
          },
          {
            id: "two",
            kind: "image",
            sourceUrl: "https://i.etsystatic.com/synthetic/two.png",
            included: true,
          },
        ],
      });
    const title = `QA Research ${suffix} original`;
    const captureFixture = async (input: unknown) => {
      return mediaFixture.capture(CaptureDraftSchema.parse(input));
    };
    const first = await captureFixture(captureInput(id, title));
    const second = await captureFixture(
      captureInput(`${id}1`, `QA Research ${suffix} alternative`),
    );
    const firstArchive = await mediaFixture.archived(first.snapshotId);
    await mediaFixture.archived(second.snapshotId);
    await page.setViewportSize({ width: 1440, height: 1000 });
    let releaseScripts!: () => void;
    const scriptGate = new Promise<void>((resolve) => {
      releaseScripts = resolve;
    });
    const scripts = /\/_next\/static\/.*\.js(?:\?.*)?$/;
    const holdScripts = async (route: Route) => {
      await scriptGate;
      await route.continue();
    };
    await page.route(scripts, holdScripts);
    try {
      await page.goto(`/research?q=${suffix}&visibility=all`, { waitUntil: "commit" });
      await expect(page.locator(".research-summary-row")).toHaveCount(2);
      await expect(
        page.getByRole("button", { name: "查看详情", exact: true }).first(),
      ).toBeDisabled();
      await expect(page.getByRole("button", { name: "归档", exact: true }).first()).toBeDisabled();
      await expect(page.getByRole("checkbox", { name: "选择当前页全部研究资料" })).toBeDisabled();
    } finally {
      releaseScripts();
    }
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("button", { name: "归档", exact: true }).first()).toBeEnabled();
    const row = page.locator(".research-summary-row").filter({ hasText: title });
    await expect(row.getByRole("button", { name: `重新读取私有图片：${title}` })).toBeVisible();
    await row.getByRole("button", { name: "查看详情" }).click();
    const dossier = page.locator(".research-dossier");
    await expect(dossier.getByText("私有图片暂时无法加载", { exact: true })).toBeVisible();
    await expect(dossier.getByRole("button", { name: "放大当前图片" })).toBeDisabled();
    imagesAvailable = true;
    await row.getByRole("button", { name: `重新读取私有图片：${title}` }).click();
    await dossier.getByRole("button", { name: "重新读取私有媒体" }).click();
    await expect
      .poll(() =>
        row
          .locator(".research-private-thumb > img")
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBeGreaterThan(0);
    await expect
      .poll(() =>
        dossier
          .locator(".research-gallery-stage img")
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBeGreaterThan(0);
    await dossier.getByRole("button", { name: /^查看图片 2 / }).click();
    await expect(dossier.locator(".research-gallery-stage img")).toHaveAttribute(
      "src",
      new RegExp(firstArchive.media[1]!.id),
    );
    await dossier.getByRole("button", { name: "放大当前图片" }).click();
    await expect(page.getByRole("dialog", { name: "竞品图片大图" })).toBeVisible();
    await expect
      .poll(() =>
        page
          .getByRole("dialog", { name: "竞品图片大图" })
          .locator("img")
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBeGreaterThan(0);
    await page.getByRole("button", { name: "关闭大图" }).click();
    await dossier.getByRole("button", { name: "研究结论", exact: true }).click();
    const study = dossier.getByRole("region", { name: "研究结论", exact: true });
    await study.getByLabel("设计主题", { exact: true }).fill(`纪念花园 ${suffix}`);
    await study.getByLabel("原创差异化方向").fill("原创花卉布局，给名字留白");
    await study.getByLabel("目标人群").fill("纪念礼物购买者");
    await study.getByLabel("研究状态", { exact: true }).selectOption("analyzed");
    await study.getByText("图片与视频批注 · 0 条", { exact: true }).click();
    await study.getByLabel("媒体 2 · 图片", { exact: true }).fill("增加文字与背景的对比度");
    await study.getByRole("button", { name: "保存研究结论" }).click();
    await expect(study.getByRole("status")).toContainText("已保存研究 V1");
    await expect(row).toContainText("已研究");
    await dossier.screenshot({ path: testInfo.outputPath("research-study-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await expect(study.getByLabel("设计主题", { exact: true })).toBeVisible();
    await study.screenshot({ path: testInfo.outputPath("research-study-mobile.png") });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await row.getByRole("button", { name: "收起", exact: true }).click();
    await page.getByRole("checkbox", { name: "选择当前页全部研究资料" }).check();
    await page.getByRole("button", { name: "加入创意项目", exact: true }).click();
    await expect(page.getByRole("heading", { name: "新建创意项目", exact: true })).toBeVisible();
    await expect(page.getByLabel("目标人群", { exact: true })).toHaveValue("纪念礼物购买者");
    await expect(page.getByLabel("创意方向与制作要求")).toHaveValue(/原创花卉布局/);
    await expect(page.getByRole("region", { name: "创意研究依据" })).toContainText(
      "增加文字与背景的对比度",
    );
    await page.getByLabel("项目名称", { exact: true }).fill(`QA Research Creative ${suffix}`);
    await page.getByLabel("目标人群", { exact: true }).fill("运营确认的人群");
    await page.getByRole("button", { name: "将研究结论填入空白需求" }).click();
    await expect(page.getByLabel("目标人群", { exact: true })).toHaveValue("运营确认的人群");
    await page.getByRole("button", { name: "审核与交付", exact: true }).click();
    await page.getByRole("button", { name: "保存需求并开始设计", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("需求已保存");
    const briefId = new URL(page.url()).searchParams.get("brief")!;
    const brief = await centerApi<CanvasBrief>(`canvas-bridge/briefs/${briefId}`);
    expect(
      brief.workflow?.researchReferences?.map((source) => source.researchItemId).sort(),
    ).toEqual([first.researchItemId, second.researchItemId].sort());
    expect(brief.referenceAssets).toEqual([]);
    expect(brief.designInstructions).toContain("增加文字与背景的对比度");
    const pinned = brief.workflow!.researchReferences!.find(
      (source) => source.researchItemId === first.researchItemId,
    )!;
    const prior = await centerApi<ResearchStudyWorkspace>(
      `research-items/${first.researchItemId}/study`,
    );
    const recaptured = await captureFixture(
      captureInput(
        id,
        `QA Research ${suffix} recaptured`,
        new Date(Date.now() + 1000).toISOString(),
      ),
    );
    await centerApi<ResearchStudyRevision>(`research-items/${first.researchItemId}/study`, {
      requestId: crypto.randomUUID(),
      snapshotId: recaptured.snapshotId,
      expectedVersion: 1,
      content: { ...prior.revision!.content, theme: "新版方向" },
    });
    const unchanged = await centerApi<CanvasBrief>(`canvas-bridge/briefs/${briefId}`);
    expect(unchanged.workflow?.researchReferences).toEqual(brief.workflow?.researchReferences);
    await page.goto(
      `/research?item=${first.researchItemId}&snapshot=${pinned.snapshotId}&study=${pinned.studyRevisionId}`,
    );
    await expect(
      page.getByRole("region", { name: "研究结论", exact: true }).getByLabel("设计主题"),
    ).toHaveValue(`纪念花园 ${suffix}`);
    await expect(
      page.getByRole("region", { name: "研究结论", exact: true }).getByLabel("设计主题"),
    ).toBeDisabled();
    await expect(page.getByRole("button", { name: "保存研究结论", exact: true })).toHaveCount(0);
    await page.goto(`/research?q=${suffix}&researchStatus=analyzed&visibility=all`);
    await expect(page.locator(".research-summary-row")).toHaveCount(1);
    await expect(page.locator(".research-summary-row")).toContainText("新版方向");
    await expect(page.locator(".research-summary-row")).toContainText("1 个项目");
    await centerApi("research-items/archive", {
      itemIds: [first.researchItemId, second.researchItemId],
      archived: true,
    });
    await page.goto(`/research?q=${suffix}`);
    await expect(page.locator(".research-summary-row")).toHaveCount(0);
    await page.getByLabel("资料范围").selectOption("archived");
    await page.getByRole("button", { name: "应用筛选" }).click();
    await expect(page.locator(".research-summary-row")).toHaveCount(2);
    try {
      await page
        .locator(".research-summary-row")
        .filter({ hasText: `QA Research ${suffix} recaptured` })
        .getByRole("button", { name: "恢复", exact: true })
        .click();
      await expect(page.locator(".research-summary-row")).toHaveCount(1);
      await page.goto(`/research?q=${suffix}`);
      await expect(page.locator(".research-summary-row")).toHaveCount(1);
      await page.getByRole("button", { name: "归档", exact: true }).click();
      await expect(page.locator(".research-summary-row")).toHaveCount(0);
    } finally {
      await centerApi("research-items/archive", {
        itemIds: [first.researchItemId, second.researchItemId],
        archived: true,
      });
    }
    expect(errors).toEqual([]);
  } finally {
    await mediaFixture.close();
  }
});
