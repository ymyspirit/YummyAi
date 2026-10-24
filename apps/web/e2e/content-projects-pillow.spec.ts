import { syntheticSpecificationFacts } from "../../../tools/testing/specification-fixtures.js";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { MarketplaceAccountView, ProductionEditorDetailView } from "@yummyai/contracts";
import type { ArtworkView, SalesRecipeView } from "@yummyai/contracts/catalog/development";
import type { OrderWorkDetail, PrintProfileView } from "@yummyai/contracts/order/workspace";
import { apiFetch } from "../src/server-api";
import { centerApi } from "./order-centers-fixture";
import {
  applyPillowFactoryStandard,
  createDefaultProductionDocument,
} from "@yummyai/production-editor/products";

test.skip(
  process.env.E2E_REAL_PRODUCTS !== "1",
  "Use the real content-projects acceptance configuration",
);

test("real pillow configuration, pinned order, cross-route return and mobile layout", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(20000);
  const suffix = randomUUID().slice(0, 8).toUpperCase(),
    externalId = `QA-PILLOW-${suffix}`;
  const directory = new URL("../../../tmp/pillow-projects/", import.meta.url);
  const manifest = new URL(`browser-${suffix}.json`, directory);
  const fixtures = {
    accountId: "",
    orderId: "",
    lines: [] as Array<{ id: string; externalLineId: string }>,
    projects: [] as string[],
    profiles: [] as string[],
    plans: [] as string[],
    artworks: [] as Array<{ id: string; version: number }>,
  };
  const persist = (extra = {}) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(manifest, JSON.stringify({ suffix, externalId, fixtures, ...extra }, null, 2));
  };
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let failure: unknown;
  const cleanupErrors: string[] = [];
  persist({ cleaned: false });
  try {
    const account = await centerApi<MarketplaceAccountView>("marketplace-accounts", {
      platform: "amazon",
      displayName: `QA Pillow ${suffix}`,
      region: "NA",
      marketplaceIds: ["ATVPDKIKX0DER"],
      authorizationMode: "amazon_private",
      requestedScopes: [],
    });
    fixtures.accountId = account.id;
    persist();
    const profiles: PrintProfileView[] = [];
    for (const kind of ["shaped_pillow", "tire_cover"] as const) {
      let document = createDefaultProductionDocument(kind);
      if (document.productType === "shaped_pillow") {
        document = applyPillowFactoryStandard(document);
        document.spec = { ...document.spec, widthMm: 254, heightMm: 254, declaredLongestMm: 254 };
      }
      document.confirmations.physicalSize = true;
      const template = await centerApi<ProductionEditorDetailView>("production-editor/projects", {
        name: `QA ${kind} ${suffix}`,
        document,
      });
      fixtures.projects.push(template.project.id);
      persist();
      await centerApi(`production-editor/projects/${template.project.id}/review`, {
        expectedVersionId: template.version.id,
      });
      const available = await centerApi<PrintProfileView[]>("order-centers/profiles", {
        code: `QA-${kind}-${suffix}`,
        name: `QA ${kind} ${suffix}`,
        projectId: template.project.id,
        versionId: template.version.id,
        instructions: "Synthetic read-only workflow fixture",
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
      });
      const profile = available.find((p) => p.code === `QA-${kind}-${suffix}`)!;
      profiles.push(profile);
      fixtures.profiles.push(profile.id);
      persist();
    }
    const { spu } = await centerApi<{ spu: { id: string; productPlanId: string } }>(
      "product-development/spus",
      {
        code: `QA-PILLOW-SPU-${suffix}`,
        name: `QA 来图抱枕 ${suffix}`,
        idempotencyKey: randomUUID(),
      },
    );
    fixtures.plans.push(spu.productPlanId);
    persist();
    const { specification } = await centerApi<{ specification: { versionId: string } }>(
      "product-development/specifications",
      {
        spuId: spu.id,
        code: `QA-PILLOW-SPEC-${suffix}`,
        name: `QA 10 in ${suffix}`,
        attributes: { Size: "10 in" },
        facts: syntheticSpecificationFacts({
          material: "Synthetic verified fabric and filling",
          dimensions: "254 mm artwork subject; synthetic QA specification",
          packageContents: "One synthetic pillow",
          packageQuantity: 1,
          factsConfirmed: true,
        }),
        processProfileVersionId: profiles[0]!.versionId,
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
      },
    );
    await centerApi("product-development/specifications", {
      spuId: spu.id,
      code: `QA-PILLOW-DRAFT-${suffix}`,
      name: `QA 待确认规格 ${suffix}`,
      attributes: { Size: "Unconfirmed" },
      facts: syntheticSpecificationFacts({
        material: "Synthetic material pending confirmation",
        dimensions: "Pending supplier size basis",
        packageContents: "Pending supplier packaging",
        packageQuantity: 1,
        factsConfirmed: false,
      }),
      processProfileVersionId: null,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
    });
    const { artwork } = await centerApi<{ artwork: ArtworkView }>("product-development/artworks", {
      code: `QA-PILLOW-ART-${suffix}`,
      name: `QA 来图方案 ${suffix}`,
      mode: "customer_image",
      creativeVersionId: null,
      customization: {
        version: 1,
        fields: [
          {
            key: "buyer_photo",
            label: "顾客原图",
            type: "image",
            required: true,
            validation: { allowedMediaTypes: ["image/png"], maxFiles: 1, maxBytes: 32000000 },
          },
        ],
      },
      instructions: "Synthetic reusable photo plan; actual photos stay private to each order",
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
    });
    fixtures.artworks.push({ id: artwork.id, version: artwork.version });
    persist();
    const combination = await centerApi<{ recipes: SalesRecipeView[] }>(
      "product-development/combinations",
      {
        artworkVersionId: artwork.versionId,
        items: [
          { specificationVersionId: specification.versionId, skuCode: `QA-PILLOW-SALE-${suffix}` },
        ],
        idempotencyKey: randomUUID(),
      },
    );
    await centerApi(`product-development/recipes/${combination.recipes[0]!.id}/actions`, {
      action: "confirm_customization_plan",
      reason: "Confirm synthetic reusable plan only",
      idempotencyKey: randomUUID(),
    });
    execFileSync(
      process.execPath,
      [
        "--env-file=../../.env",
        "--import",
        "tsx",
        fileURLToPath(new URL("./pillow-project-order-fixture.mts", import.meta.url)),
        fileURLToPath(manifest),
      ],
      {
        cwd: fileURLToPath(new URL("../../api/", import.meta.url)),
        env: process.env,
        timeout: 30000,
        windowsHide: true,
      },
    );
    Object.assign(fixtures, JSON.parse(readFileSync(manifest, "utf8")).fixtures);
    for (const line of fixtures.lines) {
      const detail = await centerApi<OrderWorkDetail>(`order-centers/lines/${line.id}`);
      const profile = line.externalLineId.startsWith("pillow")
        ? profiles[0]
        : line.externalLineId.startsWith("tire")
          ? profiles[1]
          : null;
      await centerApi(`order-centers/lines/${line.id}/draft`, {
        expectedRevision: detail.line.revision,
        expectedProjectionVersion: detail.line.projectionVersion,
        expectedSourceVersionId: null,
        draft: {
          ...detail.draft,
          designExecutor: "human",
          printProfileVersionId: profile?.versionId ?? null,
          ...(profile === profiles[0]
            ? {
                artworkVersionId: artwork.versionId,
                specificationVersionId: specification.versionId,
              }
            : {}),
          instructions: "Synthetic fixture; no production or model dispatch",
        },
        status: "pending_review",
        reason: "Synthetic partial review",
        idempotencyKey: randomUUID(),
      });
    }
    const lineId = fixtures.lines.find((l) => l.externalLineId.startsWith("pillow"))!.id;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/content-projects");
    await page.getByRole("link", { name: "异形抱枕", exact: true }).click();
    await expect(page.getByRole("heading", { name: "异形抱枕项目", exact: true })).toBeVisible();
    await page.getByLabel("订单查询").fill(externalId);
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await expect(page.getByText("共 1 个订单商品", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "查看任务", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`line=${lineId}`));
    await expect(page.getByRole("heading", { name: `本单制作 · ${externalId}` })).toBeVisible();
    await expect(
      page.getByText("派发时才固定无人设计任务规则，当前未生成任务快照", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("本单固定底稿", { exact: true })).toBeVisible();
    await page.screenshot({
      path: fileURLToPath(new URL(`desktop-${suffix}.png`, directory)),
      fullPage: true,
    });
    await page.getByRole("link", { name: "核对定制要求", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`productType=shaped_pillow.*line=${lineId}`));
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("link", { name: "返回来源订单队列", exact: true }).click();
    await expect(page.getByRole("heading", { name: `本单制作 · ${externalId}` })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      )
      .toBe(true);
    await page.screenshot({
      path: fileURLToPath(new URL(`mobile-${suffix}.png`, directory)),
      fullPage: true,
    });
    await page.getByRole("link", { name: "商品与制作方案", exact: true }).click();
    await expect(page.getByText(`QA 待确认规格 ${suffix}`, { exact: false })).toBeVisible();
    await expect(
      page.getByText(`QA-PILLOW-SALE-${suffix} · 配方 V1`, { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(`QA 来图方案 ${suffix} · V1`, { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      )
      .toBe(true);
    expect(pageErrors).toEqual([]);
  } catch (error) {
    failure = error;
  } finally {
    if (fixtures.lines.length === 0 && existsSync(manifest)) {
      const stored = JSON.parse(readFileSync(manifest, "utf8"));
      Object.assign(fixtures, stored.fixtures);
    }
    for (const line of fixtures.lines)
      try {
        let detail = await centerApi<OrderWorkDetail>(`order-centers/lines/${line.id}`);
        if (detail.line.projectionVersion === 0) {
          detail = await centerApi<OrderWorkDetail>(`order-centers/lines/${line.id}/draft`, {
            expectedRevision: detail.line.revision,
            expectedProjectionVersion: 0,
            expectedSourceVersionId: null,
            draft: { ...detail.draft, designExecutor: "human" },
            status: "pending_review",
            reason: "Create owned fixture work record for canonical archival",
            idempotencyKey: randomUUID(),
          });
        }
        await centerApi(`order-centers/lines/${line.id}/archive`, {
          archived: true,
          expectedProjectionVersion: detail.line.projectionVersion,
          reason: "Owned pillow browser fixture teardown",
          idempotencyKey: randomUUID(),
        });
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    for (const art of fixtures.artworks)
      try {
        await centerApi(`product-development/artworks/${art.id}/archive`, {
          archived: true,
          expectedVersion: art.version,
          reason: "Owned pillow browser fixture teardown",
          idempotencyKey: randomUUID(),
        });
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    for (const id of fixtures.plans)
      try {
        await centerApi(`products/plans/${id}/transitions`, { status: "archived" });
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    for (const id of fixtures.profiles)
      try {
        await centerApi(`order-centers/profiles/${id}/archive`, {
          archived: true,
          reason: "Owned pillow browser fixture teardown",
        });
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    for (const id of fixtures.projects)
      try {
        await centerApi(`production-editor/projects/${id}/archive`, {
          archived: true,
          reason: "Owned pillow browser fixture teardown",
        });
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    if (fixtures.accountId)
      try {
        const response = await apiFetch(
          `${process.env.API_BASE_URL}/v1/marketplace-accounts/${fixtures.accountId}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled: false }),
          },
        );
        expect(response.ok).toBe(true);
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    try {
      const remaining = await centerApi<{ orders: { total: number; counts: { total: number } } }>(
        `content-projects/pillow?q=${externalId}`,
      );
      expect(remaining.orders.total).toBe(0);
      expect(remaining.orders.counts.total).toBe(0);
      expect(
        (await centerApi<{ total: number }>(`order-centers/workspace?q=${externalId}`)).total,
      ).toBe(0);
      expect(
        (await centerApi<{ total: number }>(`product-development/workspace?q=${suffix}`)).total,
      ).toBe(0);
      const activeProfiles = await centerApi<PrintProfileView[]>("order-centers/profiles");
      expect(activeProfiles.some((profile) => fixtures.profiles.includes(profile.id))).toBe(false);
      const activeEditors = await centerApi<{ projects: Array<{ id: string }> }>(
        "production-editor/projects?scope=templates",
      );
      expect(activeEditors.projects.some((project) => fixtures.projects.includes(project.id))).toBe(
        false,
      );
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    persist({
      cleaned: cleanupErrors.length === 0,
      cleanupErrors,
      failure: failure instanceof Error ? failure.message : failure ? String(failure) : null,
      retainedHistory:
        "Archived immutable synthetic order/specification/plan history; fixture account disabled",
    });
  }
  await info.attach("owned-pillow-fixtures", {
    path: fileURLToPath(manifest),
    contentType: "application/json",
  });
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      `Pillow fixture cleanup incomplete: ${cleanupErrors.join("; ")}`,
    );
  if (failure) throw failure;
});
