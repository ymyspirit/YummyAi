import { syntheticSpecificationFacts } from "../../../tools/testing/specification-fixtures.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  CaptureDraftSchema,
  type ProductionEditorDetailView,
  type ProductionEditorImageView,
} from "@yummyai/contracts";
import type { ContentProject } from "@yummyai/contracts/catalog/content-project";
import type {
  DevelopmentOptions,
  DevelopmentWorkspace,
  ArtworkView,
} from "@yummyai/contracts/catalog/development";
import {
  ResearchStudyContentSchema,
  type ResearchStudyRevision,
} from "@yummyai/contracts/research/creative";
import type { PrintProfileView } from "@yummyai/contracts/order/workspace";
import { centerApi } from "./order-centers-fixture";
import { syntheticProductionPng } from "./production-editor-fixture";
import {
  createProductionDocument,
  newProductionImage,
} from "../src/features/production-editor/production-editor-model";

test.skip(
  process.env.E2E_REAL_PRODUCTS !== "1",
  "Run with playwright.content-projects.config.ts against real application paths",
);

test("real project creation, pinned research, owned design and SKU handoffs preserve context", async ({
  page,
}, info) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(20000);
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const name = `QA 商品图文 ${suffix} · 原创长标题与多规格商品的审核进度`;
  const artCode = `QA-CONTENT-ART-${suffix}`,
    spuCode = `QA-CONTENT-SPU-${suffix}`;
  const fixtures: {
    briefs: string[];
    research: string[];
    projects: string[];
    profiles: string[];
    plans: string[];
    artworks: Array<{ id: string; version: number }>;
  } = { briefs: [], research: [], projects: [], profiles: [], plans: [], artworks: [] };
  const directory = new URL("../../../tmp/content-projects/", import.meta.url);
  const manifest = new URL(`browser-${suffix}.json`, directory);
  const persist = (extra = {}) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(manifest, JSON.stringify({ suffix, name, fixtures, ...extra }, null, 2));
  };
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let rootId = "";
  let failure: unknown;
  const cleanupErrors: string[] = [];
  try {
    const timestamp = new Date().toISOString(),
      externalId = String(Date.now());
    const capture = await centerApi<{ researchItemId: string; snapshotId: string }>(
      "captures",
      CaptureDraftSchema.parse({
        platform: "etsy",
        parserVersion: "etsy@1.0.0",
        extensionVersion: "0.0.0",
        marketplace: "www.etsy.com",
        sourceUrl: `https://www.etsy.com/listing/${externalId}/synthetic-content-fixture`,
        externalId,
        title: `QA Content research ${suffix}`,
        domain: "research",
        capturedAt: timestamp,
        price: null,
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
          updatedAt: timestamp,
        },
        bullets: [],
        variants: [],
        productInformation: [],
        contentBlocks: [],
        missingFields: [],
        diagnostics: [],
        captureStatus: "partial",
        media: [],
      }),
    );
    fixtures.research.push(capture.researchItemId);
    persist();
    const study = await centerApi<ResearchStudyRevision>(
      `research-items/${capture.researchItemId}/study`,
      {
        requestId: randomUUID(),
        snapshotId: capture.snapshotId,
        expectedVersion: 0,
        content: ResearchStudyContentSchema.parse({
          theme: `原创几何 ${suffix}`,
          differentiation: "采用自有图案与留白布局",
          audience: "测试礼物购买者",
          status: "analyzed",
        }),
      },
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/content-projects");
    await expect(page.getByRole("heading", { name: "商品图文项目", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "新建图文项目", exact: true }).click();
    await expect(page.getByRole("heading", { name: "新建创意项目", exact: true })).toBeVisible();
    await page.getByLabel("项目名称", { exact: true }).fill(name);
    await page
      .getByLabel("创意方向与制作要求")
      .fill("自有原创几何图案。验收合成测试样品的版本衔接，保留细节与中间留白。".repeat(4));
    await page.getByLabel("选品研究来源").selectOption([capture.researchItemId]);
    await expect(page.getByText("采用自有图案与留白布局", { exact: false }).first()).toBeVisible();
    await page.getByRole("button", { name: "审核与交付", exact: true }).click();
    await page.getByRole("button", { name: "保存需求并开始设计", exact: true }).click();
    await expect(page).toHaveURL(/brief=[0-9a-f-]{36}/);
    rootId = new URL(page.url()).searchParams.get("brief")!;
    fixtures.briefs.push(rootId);
    persist();
    await page
      .getByLabel("来源说明", { exact: true })
      .fill("Synthetic original owned by this disposable browser fixture");
    await page.getByLabel("上传设计方案文件").setInputFiles({
      name: `owned-${suffix}.png`,
      mimeType: "image/png",
      buffer: syntheticProductionPng(),
    });
    await expect(page.locator(".canvas-result")).toHaveCount(1);
    await page.getByRole("button", { name: "审核与交付", exact: true }).click();
    await page.getByRole("checkbox", { name: `选择方案 owned-${suffix}.png`, exact: true }).check();
    await page.getByRole("button", { name: "批准选中方案", exact: true }).click();
    await expect(page.locator(".canvas-result")).toContainText("已通过");
    await page.getByRole("link", { name: "返回图文项目", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/content-projects\\?project=${rootId}`));
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(page.locator(".cp-source-list")).toContainText("研究笔记 V1");
    // Editing the study creates V2; the project remains bound to V1.
    await centerApi(`research-items/${capture.researchItemId}/study`, {
      requestId: randomUUID(),
      snapshotId: capture.snapshotId,
      expectedVersion: 1,
      content: {
        ...study.content,
        differentiation: "Later source revision must not replace pinned V1",
      },
    });
    await page.getByRole("button", { name: "刷新进度", exact: true }).click();
    await expect(page.locator(".cp-source-list")).toContainText("采用自有图案与留白布局");
    const researchLink = page.locator(".cp-source-list a");
    await expect(researchLink).toHaveAttribute("href", new RegExp(`study=${study.id}`));
    await page.locator('.cp-stages a[href*="stage=design"]').click();
    await expect(page.locator('.cp-stages a[href*="stage=design"]')).toHaveAttribute(
      "data-status",
      "complete",
    );
    await expect(page.locator(".cp-results img")).toBeVisible();
    await expect
      .poll(() =>
        page.locator(".cp-results img").evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath("content-project-desktop.png"), fullPage: true });
    const project = await centerApi<ContentProject>(`content-projects/${rootId}`);
    const { artwork } = await centerApi<{ artwork: ArtworkView }>("product-development/artworks", {
      code: artCode,
      name: `QA Original ${suffix}`,
      mode: "fixed",
      creativeVersionId: project.results[0]!.versionId,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
    });
    fixtures.artworks.push({ id: artwork.id, version: artwork.version });
    persist();
    // Small rectangular synthetic specification; no order or model provider is used.
    const document = createProductionDocument("rectangular_print");
    document.name = `QA Content process ${suffix}`;
    document.spec = { ...document.spec, widthMm: 60, heightMm: 40, dpi: 150, safeInsetMm: 2 };
    for (const key of Object.keys(document.confirmations) as Array<
      keyof typeof document.confirmations
    >)
      document.confirmations[key] = true;
    let template = await centerApi<ProductionEditorDetailView>("production-editor/projects", {
      name: document.name,
      document,
    });
    fixtures.projects.push(template.project.id);
    persist();
    const image = await centerApi<ProductionEditorImageView>(
      `production-editor/projects/${template.project.id}/images`,
      { name: "synthetic-panel.png", contentBase64: syntheticProductionPng().toString("base64") },
    );
    document.layers = [newProductionImage(document, image)];
    template = await centerApi<ProductionEditorDetailView>(
      `production-editor/projects/${template.project.id}/versions`,
      { expectedVersionId: template.version.id, document },
    );
    await centerApi(`production-editor/projects/${template.project.id}/review`, {
      expectedVersionId: template.version.id,
    });
    const profiles = await centerApi<PrintProfileView[]>("order-centers/profiles", {
      code: `QA-CONTENT-${suffix}`,
      name: document.name,
      projectId: template.project.id,
      versionId: template.version.id,
      instructions: "Synthetic rectangular test panel only",
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
    });
    const profile = profiles.find((p) => p.code === `QA-CONTENT-${suffix}`)!;
    fixtures.profiles.push(profile.id);
    persist();
    const { spu } = await centerApi<{ spu: { id: string; productPlanId: string } }>(
      "product-development/spus",
      { code: spuCode, name: `QA Small panel ${suffix}`, idempotencyKey: randomUUID() },
    );
    fixtures.plans.push(spu.productPlanId);
    persist();
    const { specification } = await centerApi<{ specification: { versionId: string } }>(
      "product-development/specifications",
      {
        spuId: spu.id,
        code: "DEFAULT",
        name: "60 × 40 mm",
        attributes: { size: "60 × 40 mm" },
        facts: syntheticSpecificationFacts({
          material: "Synthetic test fabric",
          dimensions: "60 × 40 mm",
          packageContents: "One synthetic panel",
          packageQuantity: 1,
          factsConfirmed: true,
        }),
        processProfileVersionId: profile.versionId,
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
      },
    );
    await page.getByRole("button", { name: "刷新进度", exact: true }).click();
    await page.locator('.cp-stages a[href*="stage=sku"]').click();
    await page.getByRole("link", { name: "组合商品规格", exact: true }).click();
    await expect(page.locator(".pd-combine").getByLabel("选择独立印花")).toHaveValue(
      artwork.versionId,
    );
    await centerApi("product-development/combinations", {
      artworkVersionId: artwork.versionId,
      items: [
        { specificationVersionId: specification.versionId, skuCode: `QA-CONTENT-SALE-${suffix}` },
      ],
      idempotencyKey: randomUUID(),
    });
    await page.getByRole("button", { name: "返回产品开发列表", exact: true }).click();
    await page.getByRole("link", { name: "返回原任务", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`project=${rootId}.*stage=sku`));
    await expect(page.locator(".cp-table")).toContainText(`QA-CONTENT-SALE-${suffix}`);
    await expect(page.locator(".cp-table")).toContainText("60 × 40 mm");
    await expect(page.locator(".cp-table")).toContainText("待制作");
    // A new artwork version does not rewrite the SKU's pinned recipe.
    const revision = await centerApi<{ artwork: ArtworkView }>("product-development/artworks", {
      code: artCode,
      name: `QA Updated ${suffix}`,
      mode: "fixed",
      creativeVersionId: project.results[0]!.versionId,
      expectedVersion: artwork.version,
      idempotencyKey: randomUUID(),
    });
    fixtures.artworks[0]!.version = revision.artwork.version;
    persist();
    await page.getByRole("button", { name: "刷新进度", exact: true }).click();
    await expect(page.locator(".cp-table")).toContainText("来源已有新版本");
    await expect(page.locator('.cp-stages a[href*="stage=sku"]')).toHaveAttribute(
      "data-status",
      "blocked",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({ path: info.outputPath("content-project-mobile.png"), fullPage: true });
    for (const stage of ["mockup", "listing", "delivery"]) {
      await page.locator(`.cp-stages a[href*="stage=${stage}"]`).click();
      await expect(page.locator(".cp-stage-empty")).toBeVisible();
    }
    expect(pageErrors).toEqual([]);
  } catch (error) {
    failure = error;
  } finally {
    const errors = cleanupErrors,
      reason = "Owned content-project browser fixture teardown";
    const clean = async (name: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch {
        errors.push(name);
      }
    };
    // Recover an ID if the UI saved just before an assertion interrupted the test.
    await clean("recover project ids", async () => {
      const rows = await centerApi<Array<{ id: string; name: string }>>("canvas-bridge/briefs");
      for (const row of rows)
        if (row.name === name && !fixtures.briefs.includes(row.id)) fixtures.briefs.push(row.id);
      persist();
    });
    for (const p of fixtures.plans)
      await clean(`plan:${p}`, () =>
        centerApi(`products/plans/${p}/transitions`, { status: "archived" }),
      );
    for (const a of fixtures.artworks)
      await clean(`artwork:${a.id}`, () =>
        centerApi(`product-development/artworks/${a.id}/archive`, {
          archived: true,
          expectedVersion: a.version,
          reason,
          idempotencyKey: randomUUID(),
        }),
      );
    for (const p of fixtures.profiles)
      await clean(`profile:${p}`, () =>
        centerApi(`order-centers/profiles/${p}/archive`, { archived: true, reason }),
      );
    for (const p of fixtures.projects)
      await clean(`project:${p}`, () =>
        centerApi(`production-editor/projects/${p}/archive`, { archived: true, reason }),
      );
    for (const b of fixtures.briefs)
      await clean(`brief:${b}`, () =>
        centerApi(`pod/design-batches/${b}/archive`, { archived: true, reason }),
      );
    if (fixtures.research.length)
      await clean("research", () =>
        centerApi("research-items/archive", { itemIds: fixtures.research, archived: true }),
      );
    await clean("verify working lists", async () => {
      const list = await centerApi<{ total: number }>(`content-projects?q=${suffix}`);
      const workspace = await centerApi<DevelopmentWorkspace>(
        `product-development/workspace?q=${suffix}`,
      );
      const options = await centerApi<DevelopmentOptions>("product-development/options");
      const research = await centerApi<{ total: number }>(`research-items?q=${suffix}`);
      const profiles = await centerApi<PrintProfileView[]>("order-centers/profiles");
      expect(list.total).toBe(0);
      expect(workspace.total).toBe(0);
      expect(research.total).toBe(0);
      expect(options.spus.some((s) => fixtures.plans.includes(s.productPlanId))).toBe(false);
      expect(options.artworks.some((a) => fixtures.artworks.some((f) => f.id === a.id))).toBe(
        false,
      );
      expect(profiles.some((p) => fixtures.profiles.includes(p.id))).toBe(false);
    });
    persist({
      cleaned: errors.length === 0,
      cleanupErrors: errors,
      retained:
        "Immutable capture, study, approved design, specification, recipe and private asset history remains archived",
    });
  }
  if (failure) throw failure;
  if (cleanupErrors.length)
    throw new Error(`Content project fixture cleanup incomplete: ${cleanupErrors.join(", ")}`);
});

test("invalid and unknown project links show an explicit error without stale project details", async ({
  page,
}) => {
  await page.goto("/content-projects?project=invalid");
  await expect(page.locator(".cp-error")).toContainText("图文项目编号无效");
  await expect(page.locator(".cp-detail-layout")).toHaveCount(0);
  await page.goto("/content-projects?project=019a0000-0000-7000-8000-000000000001");
  await expect(page.locator(".cp-error")).toContainText(/不存在|not found/i);
  await expect(page.locator(".cp-detail-layout")).toHaveCount(0);
});
