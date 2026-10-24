import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { expect, test } from "@playwright/test";
import JSZip from "jszip";
import { eq } from "drizzle-orm";
import { withTenant, developmentEvents, mockupBatchOutputs } from "@yummyai/database";
import type {
  SalesPlanDelivery,
  DeliveryReview,
} from "@yummyai/contracts/catalog/sales-plan-delivery";
import type { SalesPlanDetail } from "@yummyai/contracts/catalog/sales-plan";
import type { SalesPlanLaunch } from "@yummyai/contracts/catalog/sales-plan-launch";
import type { ListingService } from "../../api/src/listings/listing.service";
import { centerApi } from "./order-centers-fixture";
import { salesLaunchFixture } from "./sales-plan-launch-fixture";
import { apiFetch } from "../src/server-api";
import { loginErp } from "./erp-identity-fixture";
type ListingState = Awaited<ReturnType<ListingService["getWorkspace"]>>;

test("controlled listing delivery seals two SKUs, retries accepted requests and invalidates changed source pins", async ({
  page,
}, info) => {
  test.setTimeout(300000);
  page.setDefaultTimeout(25000);
  const fixture = await salesLaunchFixture({ pillow: true });
  const path = `sales-plans/${fixture.planId}/launch/delivery`;
  const errors: string[] = [],
    modelPosts: string[] = [],
    marketplacePosts: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const url = new URL(request.url());
    if (
      /\/api\/(ai-assists\/runs|creative-studio\/.*generate|studio-generation)/.test(url.pathname)
    )
      modelPosts.push(url.pathname);
    if (/\/api\/.*(publish|marketplace|factory-release)/.test(url.pathname))
      marketplacePosts.push(url.pathname);
  });
  const proof: Record<string, unknown> = {
    fixtureIds: fixture.ids,
    productionRelease: false,
    cleanup: "disposable runner owns database, bucket and Redis",
  };
  const proofDir = info.outputPath("delivery-proof");
  mkdirSync(proofDir, { recursive: true });
  const persist = () =>
    writeFileSync(
      join(proofDir, `browser-${fixture.planId}.json`),
      JSON.stringify(
        {
          ...proof,
          modelSubmissions: modelPosts,
          marketplaceSubmissions: marketplacePosts,
          pageErrors: errors,
        },
        null,
        2,
      ),
    );
  const current = () => centerApi<SalesPlanDelivery>(path);
  const region = page.getByRole("region", { name: "刊登与定制交付核对", exact: true });
  const reviewRequests: string[] = [],
    sealRequests: string[] = [];
  const readReviewBody = (state: SalesPlanDelivery) => ({
    expectedRevision: state.revision,
    expectedFingerprint: state.fingerprint,
    listingVersionId: state.listing!.versionId,
    imageEvidence: state.images.map((image) => ({
      assetId: image.id,
      kind: image.main ? "finished_photo" : "mockup",
    })),
    checks: { skuFacts: true, customization: true, images: true, copyClaims: true },
    note: "Synthetic isolated operator checks only; no marketplace configuration or factory release",
    idempotencyKey: randomUUID(),
  });
  try {
    const sibling = await fixture.addSibling();
    const legacy = await fixture.finish();
    let state = await current();
    expect(state.supported).toBe(true);
    expect(state.issues).toEqual([]);
    expect(state.skus).toHaveLength(2);
    expect(state.skus.map((sku) => sku.facts?.dimensions)).toEqual([
      "10 inch synthetic pillow",
      "12 inch synthetic pillow",
    ]);
    expect(state.review).toBeNull();
    expect(
      (await centerApi<SalesPlanLaunch>(`sales-plans/${fixture.planId}/launch`)).packages,
    ).toEqual([]);
    expect(state.packages.find((pack) => pack.id === legacy.packageId)?.reviewedDelivery).toBe(
      false,
    );
    // A claimed real photo cannot evade the canonical per-SKU reviewed-mockup requirement.
    const wrong = readReviewBody(state);
    const bad = await apiFetch(`${process.env.API_BASE_URL}/v1/${path}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...wrong,
        imageEvidence: wrong.imageEvidence.map((e) => ({ ...e, kind: "finished_photo" })),
      }),
    });
    expect(bad.status).toBe(409);
    expect((await current()).review).toBeNull();
    await page.setViewportSize({ width: 1440, height: 1000 });
    const href = `/sales-plans?plan=${fixture.planId}&view=tasks#sales-plan-delivery`;
    if (process.env.WEB_AUTH_MODE === "personal") await loginErp(page, "operator", href);
    else await page.goto(href);
    await expect(region).toContainText("Synthetic 12 inch pillow");
    await expect(region).toContainText("最多 20 字符");
    for (const image of state.images)
      await region
        .getByRole("combobox", { name: `图片用途：${image.name}`, exact: true })
        .selectOption(image.main ? "finished_photo" : "mockup");
    for (const name of [
      "已核对每个 SKU 的尺寸、单双面、材质与数量",
      "已核对定制字段、说明与实际 Custom 页面配置",
      "已逐张核对图片保真、用途及真实成品主图",
      "已核对标题、卖点和描述中的事实与服务承诺",
    ])
      await region.getByRole("checkbox", { name, exact: true }).check();
    await region.getByRole("textbox", { name: "核对依据与说明", exact: true }).fill(wrong.note);
    let loseReview = true;
    await page.route(`**/api/${path}/review`, async (route) => {
      const body = route.request().postDataJSON() as { idempotencyKey: string };
      reviewRequests.push(body.idempotencyKey);
      if (loseReview) {
        loseReview = false;
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "Synthetic review response lost after acceptance" }),
        });
      } else await route.continue();
    });
    await region.getByRole("button", { name: "记录交付核对", exact: true }).click();
    await expect(region.getByRole("alert")).toContainText("操作结果尚未确认");
    await expect(region.getByRole("textbox", { name: "核对依据与说明", exact: true })).toHaveValue(
      wrong.note,
    );
    await region.getByRole("button", { name: "记录交付核对", exact: true }).click();
    await expect(region.getByLabel("交付核对记录", { exact: true })).toContainText(
      "当前交付已核对",
    );
    expect(reviewRequests).toHaveLength(2);
    expect(new Set(reviewRequests).size).toBe(1);
    const recorded = await withTenant(fixture.database.db, fixture.context, (tx) =>
      tx.select().from(developmentEvents).where(eq(developmentEvents.resourceId, fixture.planId)),
    );
    expect(recorded.filter((e) => e.action === "sales_plan.delivery_review")).toHaveLength(1);
    state = await current();
    const reviewedFingerprint = state.fingerprint;
    const reviewId = state.review!.id;
    let loseSeal = true;
    await page.route(`**/api/${path}/seal`, async (route) => {
      const body = route.request().postDataJSON() as { idempotencyKey: string };
      sealRequests.push(body.idempotencyKey);
      if (loseSeal) {
        loseSeal = false;
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        const accepted = await response.json();
        fixture.ids.packages.push(accepted.packageId);
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "Synthetic seal response lost after acceptance" }),
        });
      } else await route.continue();
    });
    // The second SKU code includes the first code; use the exact immediate strong label.
    const packageRow = (skuCode: string) =>
      region.locator(".sd-package").filter({ has: page.getByText(skuCode, { exact: true }) });
    await packageRow(fixture.recipe.skuCode)
      .getByRole("button", { name: "封存此 SKU 资料包", exact: true })
      .click();
    await expect(region.getByRole("alert")).toContainText("操作结果尚未确认");
    await packageRow(fixture.recipe.skuCode)
      .getByRole("button", { name: "封存此 SKU 资料包", exact: true })
      .click();
    await expect(
      packageRow(fixture.recipe.skuCode).getByRole("link", { name: /下载当前交付包/ }),
    ).toBeVisible();
    expect(sealRequests).toHaveLength(2);
    expect(new Set(sealRequests).size).toBe(1);
    await packageRow(sibling.recipe.skuCode)
      .getByRole("button", { name: "封存此 SKU 资料包", exact: true })
      .click();
    await expect(
      packageRow(sibling.recipe.skuCode).getByRole("link", { name: /下载当前交付包/ }),
    ).toBeVisible();
    state = await current();
    expect(state.fingerprint).toBe(reviewedFingerprint);
    expect(state.review?.current).toBe(true);
    const packs = state.currentPackages;
    expect(packs).toHaveLength(2);
    expect(state.packages).toHaveLength(3);
    const launch = await centerApi<SalesPlanLaunch>(`sales-plans/${fixture.planId}/launch`);
    expect(launch.packages).toHaveLength(2);
    expect(launch.stages.find((s) => s.key === "package")?.status).toBe("ready");
    for (const pack of packs) {
      if (!fixture.ids.packages.includes(pack.id)) fixture.ids.packages.push(pack.id);
      const downloaded = await page.request.get(pack.downloadPath);
      expect(downloaded.ok()).toBe(true);
      expect(downloaded.headers()["content-type"]).toBe("application/zip");
      expect(downloaded.headers()["cache-control"]).toContain("private");
      const zip = await JSZip.loadAsync(await downloaded.body());
      for (const name of [
        "manifest.json",
        "listing-fields.json",
        "customization-config.json",
        "sku-mapping.json",
        "delivery-review.json",
        "README.txt",
      ])
        expect(zip.file(name)).not.toBeNull();
      const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
      expect(manifest.salesPlanDelivery.review.id).toBe(reviewId);
      expect(manifest.salesPlanDelivery.fingerprint).toBe(reviewedFingerprint);
      expect(manifest.recipe.skuId).toBe(pack.skuId);
      expect(manifest.listing.versionId).toBe(state.listing!.versionId);
      expect(JSON.parse(await zip.file("sku-mapping.json")!.async("string"))).toHaveLength(2);
      const configuration = JSON.parse(
        await zip.file("customization-config.json")!.async("string"),
      );
      expect(configuration.definition.fields[0].key).toBe("name");
      expect(configuration.definition.fields[0].validation.maxLength).toBe(20);
      expect(configuration.materials[0].assetId).toBe(fixture.configurationSample!.id);
      expect(
        Object.keys(zip.files).some((name) =>
          name.startsWith(`customization/${fixture.configurationSample!.id}-`),
        ),
      ).toBe(true);
      expect(Object.keys(zip.files).some((name) => name.startsWith("production/"))).toBe(true);
      expect(await zip.file("README.txt")!.async("string")).toContain(
        "不代表平台发布或工厂生产放行",
      );
    }
    proof.currentPackages = packs;
    proof.review = state.review;
    proof.retryKeys = { review: reviewRequests, seal: sealRequests };
    // Responsive evidence covers the actual private previews, source facts and reviewed package UI.
    for (const details of await region.locator("details.sd-section").all())
      await details.evaluate((el) => el.setAttribute("open", ""));
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
      await region.screenshot({ path: info.outputPath(`sales-delivery-region-${name}.png`) });
      await page.screenshot({
        path: info.outputPath(`sales-delivery-${name}.png`),
        fullPage: true,
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${name} overflow`,
      ).toBe(true);
    }
    if (process.env.VISUAL_LIGHTHOUSE_CLI) {
      const report = info.outputPath("sales-delivery-lighthouse.json");
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
          reject(new Error("Lighthouse timeout"));
        }, 60000);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`Lighthouse exit ${code}`));
        });
        child.stderr?.resume();
      });
      const result = JSON.parse(readFileSync(report, "utf8"));
      proof.lighthouse = {
        scores: Object.fromEntries(
          Object.entries(result.categories as Record<string, { score: number }>).map(([k, v]) => [
            k,
            v.score * 100,
          ]),
        ),
        failedAudits: Object.entries(result.audits as Record<string, { score: number | null }>)
          .filter(([, v]) => v.score !== null && v.score < 1)
          .map(([k]) => k),
        runtime: "development server",
      };
    }
    // Revoking an approved mockup is a source change even when its asset bytes stay intact.
    await withTenant(fixture.database.db, fixture.context, (tx) =>
      tx
        .update(mockupBatchOutputs)
        .set({ status: "rejected" })
        .where(eq(mockupBatchOutputs.assetId, sibling.image.id)),
    );
    const revoked = await current();
    expect(revoked.review?.current).toBe(false);
    expect(revoked.review?.changes.map((c) => c.label)).toContain("套图来源或审核状态变化");
    expect(revoked.packages.every((pack) => !pack.current)).toBe(true);
    const revokedDownload = await page.request.get(packs[0]!.downloadPath);
    expect(revokedDownload.status()).toBe(409);
    await withTenant(fixture.database.db, fixture.context, (tx) =>
      tx
        .update(mockupBatchOutputs)
        .set({ status: "approved" })
        .where(eq(mockupBatchOutputs.assetId, sibling.image.id)),
    );
    expect((await current()).review?.current).toBe(true);
    // Canonical revision flow: preserve approved history, create a draft, sync plan, approve.
    const detail = await centerApi<SalesPlanDetail>(`sales-plans/${fixture.planId}`);
    await centerApi(`sales-plans/${fixture.planId}`, {
      expectedRevision: detail.plan.revision,
      fields: {
        ...detail.plan.fields,
        customInstructions:
          "Enter a name up to 20 characters; verify the spelling before ordering.",
      },
      idempotencyKey: randomUUID(),
    });
    const changed = await current();
    expect(changed.review?.current).toBe(false);
    expect(changed.packages.every((pack) => !pack.current)).toBe(true);
    await page.reload();
    await expect(region.getByLabel("交付核对记录", { exact: true })).toContainText(
      "上次交付核对已失效",
    );
    expect(
      await region
        .getByRole("checkbox", { name: "已核对每个 SKU 的尺寸、单双面、材质与数量", exact: true })
        .isChecked(),
    ).toBe(false);
    expect((await page.request.get(packs[0]!.downloadPath)).status()).toBe(409);
    const historical = await page.request.get(
      changed.packages.find((p) => p.id === packs[0]!.id)!.downloadPath,
    );
    expect(historical.status()).toBe(200);
    const originalZip = await JSZip.loadAsync(await historical.body(), { checkCRC32: true });
    expect(
      JSON.parse(await originalZip.file("manifest.json")!.async("string")).salesPlanDelivery.review
        .id,
    ).toBe(reviewId);
    const rejected = await apiFetch(`${process.env.API_BASE_URL}/v1/${path}/seal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reviewId,
        skuId: fixture.recipe.skuId,
        expectedFingerprint: reviewedFingerprint,
        idempotencyKey: randomUUID(),
      }),
    });
    expect(rejected.status).toBe(409);
    const listingId = state.listing!.id;
    const listing = await centerApi<ListingState>(`listings/${listingId}`);
    const revision = await apiFetch(
      `${process.env.API_BASE_URL}/v1/listings/${listingId}/versions`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "if-match": listing.version.id },
        body: JSON.stringify({
          ...listing.version.content,
          personalization: {
            ...listing.version.content.personalization,
            instructions: "Enter a name up to 20 characters; verify the spelling before ordering.",
          },
        }),
      },
    );
    expect(revision.ok).toBe(true);
    const pending = await centerApi<SalesPlanDetail>(`sales-plans/${fixture.planId}`);
    await centerApi(`sales-plans/${fixture.planId}/draft`, {
      expectedRevision: pending.plan.revision,
      expectedListingVersionId: pending.listings[0]!.versionId,
      idempotencyKey: randomUUID(),
    });
    const synced = await centerApi<ListingState>(`listings/${listingId}`);
    await centerApi(`listings/${listingId}/versions/${synced.version.id}/approve`, {});
    const fresh = await current();
    expect(fresh.issues).toEqual([]);
    const reviewed = await centerApi<{ review: DeliveryReview }>(
      `${path}/review`,
      readReviewBody(fresh),
    );
    const renewed = await centerApi<{ packageId: string }>(`${path}/seal`, {
      reviewId: reviewed.review.id,
      skuId: fixture.recipe.skuId,
      expectedFingerprint: fresh.fingerprint,
      idempotencyKey: randomUUID(),
    });
    fixture.ids.packages.push(renewed.packageId);
    const final = await current();
    expect(final.packages).toHaveLength(4);
    expect(final.packages.find((p) => p.id === renewed.packageId)?.current).toBe(true);
    expect(
      final.packages.filter((p) => packs.some((old) => old.id === p.id)).every((p) => !p.current),
    ).toBe(true);
    proof.recovery = {
      reviewId: reviewed.review.id,
      packageId: renewed.packageId,
      previousPackagesRetained: packs.map((p) => p.id),
    };
    await fixture.mutateAsset();
    const deleted = await current();
    expect(deleted.review?.current).toBe(false);
    expect(deleted.issues.some((i) => i.path === `assets.${fixture.mockup.id}`)).toBe(true);
    expect(
      (
        await page.request.get(final.packages.find((p) => p.id === renewed.packageId)!.downloadPath)
      ).status(),
    ).toBe(409);
    expect(modelPosts).toEqual([]);
    expect(marketplacePosts).toEqual([]);
    expect(errors).toEqual([]);
    proof.changedSourcesBlocked = true;
  } finally {
    persist();
    await fixture.close();
  }
});
