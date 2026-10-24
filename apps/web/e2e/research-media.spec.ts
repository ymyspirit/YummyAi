import { expect, test, type Browser, type TestInfo } from "@playwright/test";
import { Permission } from "../../../packages/authz/src/index";
import { CaptureDraftSchema, type CaptureDraft } from "@yummyai/contracts";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { syntheticProductionPng } from "./production-editor-fixture";
import { centerApi } from "./order-centers-fixture";
import { researchMediaFixture } from "./research-media-fixture";

function input(title: string, media: CaptureDraft["media"]) {
  return CaptureDraftSchema.parse({
    platform: "amazon",
    marketplace: "www.amazon.com",
    parserVersion: "media-browser-v1",
    extensionVersion: "0.0.0",
    sourceUrl: `https://www.amazon.com/dp/${crypto.randomUUID()}`,
    externalId: crypto.randomUUID(),
    title,
    domain: "research",
    capturedAt: new Date().toISOString(),
    price: null,
    rating: null,
    reviewCount: null,
    listingPublishedAt: null,
    favoriteCount: null,
    shipping: null,
    shop: null,
    taxonomy: [],
    bullets: [],
    variants: [],
    productInformation: [],
    contentBlocks: [],
    missingFields: [],
    diagnostics: [],
    media,
    reviewSummary: null,
    reviews: [],
    reviewCollection: {
      collectedCount: 0,
      reportedTotal: null,
      pageCount: 0,
      status: "visible",
      updatedAt: new Date().toISOString(),
    },
    captureStatus: "complete",
  });
}

async function playableVideo(browser: Browser, testInfo: TestInfo) {
  const context = await browser.newContext({
    viewport: { width: 160, height: 90 },
    recordVideo: { dir: testInfo.outputPath("fixture-video"), size: { width: 160, height: 90 } },
  });
  const view = await context.newPage(),
    recording = view.video();
  try {
    await view.setContent(
      '<body style="margin:0;background:#2463eb"><div style="width:25px;height:25px;background:white;position:absolute;top:30px"></div></body>',
    );
    await view.evaluate(async () => {
      for (let frame = 0; frame < 20; frame++) {
        document.querySelector("div")!.style.left = frame * 6 + "px";
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    });
  } finally {
    await context.close();
  }
  if (!recording) throw new Error("Synthetic video recording unavailable");
  return readFile(await recording.path());
}

test("private research images and playable video retain source order, current access and responsive controls", async ({
  page,
  browser,
}, testInfo) => {
  const fixture = await researchMediaFixture(),
    suffix = crypto.randomUUID().slice(0, 8),
    title = `Synthetic 研究媒体 ${suffix}`;
  const errors: string[] = [],
    browserSources: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => browserSources.push(request.url()));
  try {
    const video = await playableVideo(browser, testInfo),
      image = syntheticProductionPng(64);
    const media = [
      fixture.media(image),
      fixture.media(syntheticProductionPng(80)),
      fixture.media(video, "video"),
      fixture.media(image, "image", { fail: true }),
      fixture.media(image, "image", { included: false }),
    ];
    const captured = await fixture.capture(input(title, media));
    // Install before application timers exist; late installation leaves native
    // polling timers outside the controlled clock (Playwright Clock contract).
    await page.clock.install();
    await page.goto(
      `/research?q=${suffix}&item=${captured.researchItemId}&snapshot=${captured.snapshotId}`,
    );
    const gallery = page.getByRole("figure", { name: "竞品媒体浏览" });
    await expect(gallery).toContainText("待处理 4");
    await expect(gallery).toContainText("字段：采集完成");
    await fixture.startWorker();
    const archived = await fixture.archived(captured.snapshotId);
    expect(archived.counts).toEqual({
      queued: 0,
      processing: 0,
      archived: 3,
      failed: 1,
      excluded: 1,
    });
    expect(fixture.reads).toHaveLength(4);
    expect(fixture.reads).not.toContain(media[4]!.sourceUrl);
    await gallery.getByRole("button", { name: "刷新媒体归档状态" }).click();
    await expect(gallery).toContainText("已归档 3/5");
    await expect(gallery).toContainText("归档失败 1");
    const stageImage = gallery.locator(".research-gallery-stage img");
    await expect
      .poll(() => stageImage.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBe(64);
    const firstId = archived.media[0]!.id,
      secondId = archived.media[1]!.id,
      videoId = archived.media[2]!.id;
    await expect(stageImage).toHaveAttribute(
      "src",
      new RegExp(`/api/capture-media/${captured.snapshotId}/${firstId}`),
    );
    await gallery.getByRole("button", { name: "放大当前图片" }).click();
    const dialog = page.getByRole("dialog", { name: "竞品图片大图" });
    await expect(dialog).toBeVisible();
    await dialog.press("ArrowRight");
    await expect(dialog.locator("img")).toHaveAttribute("src", new RegExp(secondId));
    await expect
      .poll(() => dialog.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBe(80);
    await dialog.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(gallery.getByRole("button", { name: "放大当前图片" })).toBeFocused();
    await gallery.getByRole("button", { name: /^查看视频 3 / }).click();
    const player = gallery.locator("video");
    await expect
      .poll(() => player.evaluate((video: HTMLVideoElement) => video.readyState))
      .toBeGreaterThanOrEqual(2);
    await player.evaluate((video: HTMLVideoElement) => video.play());
    await expect
      .poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime))
      .toBeGreaterThan(0.1);
    await player.evaluate((video: HTMLVideoElement) => video.pause());
    const content = `/api/capture-media/${captured.snapshotId}/${videoId}`;
    const range = await page.request.get(content, { headers: { range: "bytes=0-31" } });
    expect(range.status()).toBe(206);
    expect(range.headers()["content-range"]).toBe(`bytes 0-31/${video.length}`);
    expect(await range.body()).toEqual(video.subarray(0, 32));
    const whole = await page.request.get(content);
    expect(whole.status()).toBe(200);
    expect(
      createHash("sha256")
        .update(await whole.body())
        .digest("hex"),
    ).toBe(archived.media[2]!.checksumSha256);
    const outside = await page.request.get(content, {
      headers: { range: `bytes=${video.length + 100}-` },
    });
    expect(outside.status()).toBe(416);
    expect(outside.headers()["content-range"]).toBe(`bytes */${video.length}`);
    await gallery.getByRole("button", { name: /^查看图片 4 / }).click();
    await expect(gallery).toContainText("公开来源暂未返回可用媒体");
    await expect(gallery).toContainText("重新采集");
    await gallery.getByRole("button", { name: /^查看图片 5 / }).click();
    await expect(gallery).toContainText("采集时未选择此媒体进行归档");
    await gallery.getByRole("button", { name: /^查看图片 1 / }).click();
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 1024) {
        await page.getByRole("button", { name: "深色", exact: true }).click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      }
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      expect(
        (await gallery.locator(".research-gallery-stage").boundingBox())!.height,
      ).toBeLessThanOrEqual(421);
      await gallery.screenshot({ path: testInfo.outputPath(`private-media-${width}.png`) });
    }
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    await gallery.getByRole("button", { name: "放大当前图片" }).click();
    await expect(dialog).toBeVisible();
    expect((await dialog.boundingBox())!.width).toBeGreaterThan(300);
    await dialog.screenshot({ path: testInfo.outputPath("private-media-reduced-motion.png") });
    await fixture.permissions(
      Object.values(Permission).filter((value) => value !== Permission.AssetRead),
    );
    expect((await page.request.get(content)).status()).toBe(403);
    await page.clock.fastForward(31_000);
    await expect(dialog).not.toBeVisible();
    await expect(gallery).toContainText("当前成员没有查看私有媒体的权限");
    await expect(gallery.locator("img,video")).toHaveCount(0);
    expect((await page.request.get(content)).status()).toBe(403);
    await fixture.permissions(
      Object.values(Permission).filter((value) => value !== Permission.CaptureRead),
    );
    expect((await page.request.get(`/api/capture-media/${captured.snapshotId}`)).status()).toBe(
      403,
    );
    await fixture.permissions();
    await page.reload();
    await expect
      .poll(() =>
        gallery
          .locator(".research-gallery-stage img")
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(64);
    await centerApi("research-items/archive", {
      itemIds: [captured.researchItemId],
      archived: true,
    });
    await gallery.getByRole("button", { name: "刷新媒体归档状态" }).click();
    await expect(gallery).toContainText("资料已归档 不再签发媒体访问");
    expect((await page.request.get(content)).status()).toBe(404);
    expect(
      browserSources.some((url) => /media-amazon\.com|etsystatic\.com|X-Amz-Signature/i.test(url)),
    ).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("research gallery loads every page and refresh preserves the selected original position", async ({
  page,
}) => {
  const fixture = await researchMediaFixture(),
    suffix = crypto.randomUUID().slice(0, 8);
  try {
    const media = Array.from({ length: 101 }, () =>
      fixture.media(syntheticProductionPng(8), "image", { included: false }),
    );
    const captured = await fixture.capture(input(`Synthetic 分页研究 ${suffix}`, media));
    await page.goto(
      `/research?q=${suffix}&item=${captured.researchItemId}&snapshot=${captured.snapshotId}`,
    );
    const gallery = page.getByRole("figure", { name: "竞品媒体浏览" });
    await expect(gallery).toContainText("未选入 101");
    await expect(gallery.getByRole("button", { name: /^查看图片 / })).toHaveCount(100);
    await gallery.getByRole("button", { name: /载入更多媒体/ }).click();
    await expect(gallery.getByRole("button", { name: /^查看图片 / })).toHaveCount(101);
    const last = gallery.getByRole("button", { name: /^查看图片 101 / });
    await last.click();
    await gallery.getByRole("button", { name: "刷新媒体归档状态" }).click();
    await expect(last).toHaveAttribute("aria-pressed", "true");
    expect(fixture.reads).toEqual([]);
  } finally {
    await fixture.close();
  }
});
