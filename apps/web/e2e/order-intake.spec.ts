import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test, type Page, type Request, type Response, type TestInfo } from "@playwright/test";
import {
  type AmazonReportBatchView,
  type AmazonReportWorkspaceView,
  type MarketplaceAccountView,
} from "@yummyai/contracts";
import {
  OrderIntakeCheckViewSchema,
  OrderWorkDetailViewSchema,
  SaveOrderWorkDraftInputSchema,
  type OrderIntakeCheck,
  type OrderWorkDetail,
  type OrderWorkDraft,
} from "@yummyai/contracts/order/workspace";
import type { SalesPlanDelivery } from "@yummyai/contracts/catalog/sales-plan-delivery";
import type { SalesPlanDetail } from "@yummyai/contracts/catalog/sales-plan";
import { salesLaunchFixture } from "./sales-plan-launch-fixture";
import { centerApi } from "./order-centers-fixture";
import { syntheticProductionPng } from "./production-editor-fixture";
import { apiFetch } from "../src/server-api";
import { loginErp } from "./erp-identity-fixture";
import { orderIntakePillowFixture, type OrderIntakePillowFixture } from "./order-intake-pillow-fixture";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";

test("controlled order intake preserves sealed configuration, blocks mismatches and resumes corrected orders", async ({
  page,
}, testInfo) => {
  test.setTimeout(300000);
  page.setDefaultTimeout(25000);
  const fixture = await salesLaunchFixture({ pillow: true, orderIntake: true });
  const proofDir = testInfo.outputPath("sealed-intake");
  mkdirSync(proofDir, { recursive: true });
  const proof: Record<string, unknown> = {
    fixtureIds: fixture.ids,
    modelCalls: 0,
    factoryReleases: 0,
    cleanup: "disposable runner",
  };
  const errors: string[] = [],
    modelPosts: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/(ai-assists\/runs|creative-studio\/.*generate|studio-generation|order-centers\/lines\/.*\/release)/.test(
        request.url(),
      )
    )
      modelPosts.push(new URL(request.url()).pathname);
  });
  const raw = async (path: string, input: unknown) =>
    apiFetch(`${process.env.API_BASE_URL}/v1/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  try {
    const sibling = await fixture.addSibling();
    const legacy = await fixture.finish();
    const path = `sales-plans/${fixture.planId}/launch/delivery`;
    let delivery = await centerApi<SalesPlanDelivery>(path);
    expect(delivery.issues).toEqual([]);
    await centerApi(`${path}/review`, {
      expectedRevision: delivery.revision,
      expectedFingerprint: delivery.fingerprint,
      listingVersionId: delivery.listing!.versionId,
      imageEvidence: delivery.images.map((image) => ({
        assetId: image.id,
        kind: image.main ? "finished_photo" : "mockup",
      })),
      checks: { skuFacts: true, customization: true, images: true, copyClaims: true },
      note: "Synthetic isolated field/ordering fixture; no model quality or real manufacturing approval",
      idempotencyKey: randomUUID(),
    });
    delivery = await centerApi<SalesPlanDelivery>(path);
    const packs = [];
    for (const sku of delivery.skus) {
      const sealedResponse = await raw(`${path}/seal`, {
        reviewId: delivery.review!.id,
        skuId: sku.id,
        expectedFingerprint: delivery.fingerprint,
        idempotencyKey: randomUUID(),
      });
      const sealedResult = await sealedResponse.json();
      expect(
        sealedResponse.ok,
        `Synthetic seal: ${sealedResponse.status} ${sealedResult.message ?? ""}`,
      ).toBe(true);
      packs.push(sealedResult as { packageId: string });
    }
    const account = await centerApi<MarketplaceAccountView>("marketplace-accounts", {
      platform: "amazon",
      displayName: `Synthetic intake ${fixture.planId.slice(-8)}`,
      region: "NA",
      marketplaceIds: ["ATVPDKIKX0DER"],
      authorizationMode: "amazon_private",
      requestedScopes: [],
    });
    const recipes = [fixture.recipe, sibling.recipe];
    const effectiveFrom = new Date(Date.now() - 3600000).toISOString();
    for (const [index, recipe] of recipes.entries())
      await centerApi("product-development/channels", {
        packageId: packs[index]!.packageId,
        accountId: account.id,
        externalSku: recipe.skuCode,
        externalListingId: `SYNTHETIC-ASIN-${index}`,
        effectiveFrom,
        evidence: "Synthetic store mapping, not marketplace authorization or publication",
        idempotencyKey: randomUUID(),
      });
    await centerApi("product-development/channels", {
      packageId: legacy.packageId,
      accountId: account.id,
      externalSku: "SYNTHETIC-LEGACY-INTAKE",
      externalListingId: "SYNTHETIC-LEGACY-ASIN",
      effectiveFrom,
      evidence: "Historical fixture mapping without new delivery review",
      idempotencyKey: randomUUID(),
    });
    const externalIds = [0, 1, 2].map((index) => `INTAKE-${fixture.planId.slice(-8)}-${index}`);
    const reportInput = {
      accountId: account.id,
      marketplaceId: "ATVPDKIKX0DER",
      fileName: "synthetic-intake.txt",
      content:
        "order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\n" +
        externalIds
          .map(
            (external, index) =>
              `${external}\tLINE-${index}\t${new Date().toISOString()}\t${recipes[index]?.skuCode ?? "SYNTHETIC-LEGACY-INTAKE"}\tSynthetic controlled pillow\t1\tUSD\t20.00`,
          )
          .join("\n"),
    };
    const batch = await centerApi<AmazonReportBatchView>("orders/reports/import", reportInput);
    const imported = await centerApi<AmazonReportWorkspaceView>(
      `orders/reports/workspace?batchId=${batch.id}`,
    );
    const lines = externalIds.map(
      (external) => imported.lines.find((line) => line.externalOrderId === external)!.orderLineId,
    );
    proof.orders = lines;
    proof.packages = packs;
    proof.accountId = account.id;
    const duplicate = await centerApi<AmazonReportBatchView>("orders/reports/import", reportInput);
    expect(duplicate.duplicateOrderCount).toBe(3);
    expect(duplicate.newOrderCount).toBe(0);
    let first = await centerApi<OrderWorkDetail>(`order-centers/lines/${lines[0]}`);
    const second = await centerApi<OrderWorkDetail>(`order-centers/lines/${lines[1]}`);
    expect(first.draft.salesPackageId).toBe(packs[0]!.packageId);
    expect(second.draft.specificationVersionId).toBe(sibling.specification.versionId);
    const check = async (detail: OrderWorkDetail, draft: OrderWorkDraft) =>
      OrderIntakeCheckViewSchema.parse(
        await centerApi<OrderIntakeCheck>(`order-centers/lines/${detail.line.id}/intake-check`, {
          expectedRevision: detail.line.revision,
          expectedSourceVersionId: detail.report?.versionId ?? null,
          draft,
        }),
      );
    const draft: OrderWorkDraft = {
      ...first.draft,
      designExecutor: "human",
      fields: [{ key: "provider-name", label: "Ｎａｍｅ", kind: "text", value: "Synthetic Alex" }],
      images: [],
    };
    const missing = await check(first, draft);
    expect(missing.basis, JSON.stringify(missing.issues)).toBe("sealed");
    expect(missing.ready).toBe(false);
    expect(missing.issues.map((issue) => issue.code)).toContain("missing_required");
    const legacyDetail = await centerApi<OrderWorkDetail>(`order-centers/lines/${lines[2]}`);
    const legacyCheck = await check(legacyDetail, {
      ...legacyDetail.draft,
      designExecutor: "human",
    });
    expect(legacyCheck.basis).toBe("legacy_package");
    expect(legacyCheck.package?.reviewId).toBeNull();
    expect(legacyCheck.notes.join(" ")).toContain("不补写今天的配置");
    first = await centerApi<OrderWorkDetail>(`order-centers/lines/${first.line.id}/draft`, {
      expectedRevision: first.line.revision,
      expectedSourceVersionId: first.report?.versionId ?? null,
      draft,
      status: "needs_information",
      reason: "Synthetic missing original",
      idempotencyKey: randomUUID(),
    });
    first = await centerApi<OrderWorkDetail>(`order-centers/lines/${first.line.id}/images`, {
      name: "synthetic-buyer-original.png",
      contentBase64: syntheticProductionPng(128).toString("base64"),
    });
    const selected = {
      ...draft,
      images: [{ origin: "upload" as const, key: first.assets.at(-1)!.id, usage: "Portrait" }],
    };
    expect((await check(first, selected)).ready).toBe(true);
    expect(
      (
        await check(second, {
          ...second.draft,
          designExecutor: "human",
          fields: selected.fields,
          images: selected.images,
        })
      ).issues.map((issue) => issue.code),
    ).toContain("basis_or_image_invalid");
    expect(
      (
        await check(first, {
          ...selected,
          fields: [...selected.fields, { ...selected.fields[0]!, key: "other-name" }],
        })
      ).issues.map((issue) => issue.code),
    ).toContain("duplicate_value");
    expect(
      (
        await check(first, {
          ...selected,
          fields: [{ ...selected.fields[0]!, key: "name", label: "Portrait" }],
        })
      ).issues.map((issue) => issue.code),
    ).toContain("ambiguous_field");
    expect(
      (await check(first, { ...selected, salesPackageId: null })).issues.map((issue) => issue.code),
    ).toContain("missing_delivery_reference");
    expect(
      (await check(first, { ...selected, salesPackageId: legacy.packageId })).issues.map(
        (issue) => issue.code,
      ),
    ).toContain("channel_package_mismatch");
    const legacyBypass = await raw(`order-centers/lines/${first.line.id}/draft`, {
      expectedRevision: first.line.revision,
      expectedSourceVersionId: first.report?.versionId ?? null,
      draft: { ...selected, salesPackageId: legacy.packageId },
      status: "ready_to_push",
      reason: "Synthetic legacy package bypass rejection",
      idempotencyKey: randomUUID(),
    });
    expect(legacyBypass.status).toBe(409);
    expect(
      (
        await check(first, {
          ...selected,
          salesRecipeVersionId: sibling.recipe.id,
          salesPackageId: packs[1]!.packageId,
          artworkVersionId: sibling.recipe.artwork.versionId,
          specificationVersionId: sibling.specification.versionId,
          printProfileVersionId: sibling.recipe.specification.processProfileVersionId,
        })
      ).issues.map((issue) => issue.code),
    ).toContain("channel_package_mismatch");
    const invalidSave = await raw(`order-centers/lines/${first.line.id}/draft`, {
      expectedRevision: first.line.revision,
      expectedSourceVersionId: first.report?.versionId ?? null,
      draft,
      status: "ready_to_push",
      reason: "Synthetic incomplete rejection",
      idempotencyKey: randomUUID(),
    });
    expect(invalidSave.status).toBe(409);
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (process.env.WEB_AUTH_MODE === "personal") await loginErp(page);
    await page.goto(`/orders?q=${externalIds[0]}`);
    await page.getByRole("button", { name: externalIds[0], exact: true }).click();
    const region = page.getByRole("region", { name: "定制订单承接核对", exact: true });
    await expect(region).toContainText("请补齐必填定制内容：Portrait");
    await page.locator("summary").filter({ hasText: /^高级修改与原始字段/ }).click();
    await page.locator('.oc-custom-field[data-review-field="provider-name"]')
      .getByRole("combobox", { name: "对应定制字段", exact: true }).selectOption("name");
    const nameRow = page.locator('.oc-custom-field[data-review-field="name"]');
    await expect(nameRow.getByLabel("字段名称", { exact: true })).toHaveValue("Name");
    await expect(nameRow.getByLabel("定制内容", { exact: true })).toHaveValue("Synthetic Alex");
    await page.locator("summary").filter({ hasText: /^手动指定印花或改选制作依据/ }).click();
    await page
      .getByRole("combobox", { name: "销售 SKU 制作版本", exact: true })
      .selectOption(sibling.recipe.id);
    await expect(region).toContainText("本单渠道已有封存定制资料");
    await page.getByRole("button", { name: "使用下单时渠道映射", exact: true }).click();
    await expect(
      page.getByRole("combobox", { name: "销售 SKU 制作版本", exact: true }),
    ).toHaveValue(fixture.recipe.id);
    const originalImage = page.getByRole("checkbox", { name: "synthetic-buyer-original.png", exact: true });
    await expect(originalImage).not.toBeChecked();
    await originalImage.check();
    await page.locator(".oc-image").filter({ has: originalImage })
      .getByRole("combobox", { name: "对应图片字段", exact: true }).selectOption("portrait");
    await expect(region).toContainText("可以确认审单");
    const requests: string[] = [], requestBodies: string[] = [];
    let drop = true;
    await page.route(`**/api/order-centers/lines/${first.line.id}/draft`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      requests.push(route.request().postDataJSON().idempotencyKey);
      requestBodies.push(route.request().postData()!);
      const response = await route.fetch();
      if (drop && response.ok()) {
        drop = false;
        return route.abort("failed");
      }
      return route.fulfill({ response });
    });
    const saveButton = page.getByRole("button", { name: "确认本件审单", exact: true });
    await saveButton.click();
    await expect
      .poll(
        async () =>
          (await centerApi<OrderWorkDetail>(`order-centers/lines/${first.line.id}`)).line.revision,
      )
      .toBe(first.line.revision + 1);
    await expect(saveButton).toBeDisabled();
    const recovery = page.getByRole("button", { name: "核对上次保存结果", exact: true });
    await expect(recovery).toBeEnabled();
    await recovery.click();
    await expect(region).toContainText("审单已确认");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
    expect(requestBodies[0]).toBe(requestBodies[1]);
    expect(JSON.parse(requestBodies[0]!)).toEqual(JSON.parse(requestBodies[1]!));
    first = await centerApi<OrderWorkDetail>(`order-centers/lines/${first.line.id}`);
    expect(first.versions).toHaveLength(2);
    expect(first.draft.fields[0]!.key).toBe("name");
    expect(first.draft.images[0]!.usage).toBe("portrait");
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname ===
      `/api/order-centers/lines/${first.line.id}/intake-check` && response.request().method() === "POST");
    await region.getByRole("button", { name: "核对当前需求", exact: true }).click();
    const refreshedResponse = await refreshed;
    expect(refreshedResponse.ok()).toBe(true);
    const refreshedCheck = OrderIntakeCheckViewSchema.parse(await refreshedResponse.json());
    expect(refreshedCheck.ready).toBe(true);
    expect(refreshedCheck.package?.id).toBe(packs[0]!.packageId);
    await region.locator("summary").filter({ hasText: /^查看自动匹配与核对详情/ }).click();
    await expect(region).toContainText(packs[0]!.packageId);
    for (const [name, width, dark] of [
      ["desktop", 1440, false],
      ["mobile", 390, false],
      ["mobile-dark", 390, true],
    ] as const) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await page.evaluate((dark) => {
        document.documentElement.dataset.theme = dark ? "dark" : "light";
      }, dark);
      await expect(region).toBeVisible();
      expect(
        await region.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      await region.screenshot({
        path: testInfo.outputPath("sealed-intake", `${name}.png`),
      });
      await page.screenshot({
        path: testInfo.outputPath("sealed-intake", `page-${name}.png`),
        fullPage: true,
      });
    }
    const push = {
      action: "push",
      expectedRevision: first.line.revision,
      expectedProjectionVersion: first.line.projectionVersion,
      reason: "Synthetic human handoff; no model execution",
      idempotencyKey: randomUUID(),
    };
    const pushed = await centerApi<OrderWorkDetail>(
      `order-centers/lines/${first.line.id}/actions`,
      push,
    );
    const repeated = await centerApi<OrderWorkDetail>(
      `order-centers/lines/${first.line.id}/actions`,
      push,
    );
    expect(pushed.line.preparation).toBe("pushed");
    expect(repeated.line.projectionVersion).toBe(pushed.line.projectionVersion);
    expect(repeated.events.filter((event) => event.action === "push")).toHaveLength(1);
    const currentPlan = await centerApi<SalesPlanDetail>(`sales-plans/${fixture.planId}`);
    await centerApi(`sales-plans/${fixture.planId}`, {
      fields: { ...currentPlan.plan.fields, customInstructions: "A later configuration revision" },
      expectedRevision: currentPlan.plan.revision,
      idempotencyKey: randomUUID(),
    });
    // A later, backdated mapping must not substitute the package of an already
    // saved order. The original mapping remains immutable and tenant scoped.
    await centerApi("product-development/channels", {
      packageId: legacy.packageId,
      accountId: account.id,
      externalSku: fixture.recipe.skuCode,
      externalListingId: "SYNTHETIC-ASIN-0",
      effectiveFrom: new Date(new Date(effectiveFrom).getTime() + 1000).toISOString(),
      evidence: "Synthetic later channel correction; historical order pins stay unchanged",
      idempotencyKey: randomUUID(),
    });
    const historical = await check(repeated, repeated.draft);
    expect(historical.ready).toBe(true);
    expect(historical.package?.fingerprint).toBe(delivery.fingerprint);
    expect(historical.package?.planRevision).toBe(currentPlan.plan.revision);
    expect(
      (await centerApi<OrderWorkDetail>(`order-centers/lines/${first.line.id}`)).draft,
    ).toEqual(repeated.draft);
    expect(errors).toEqual([]);
    expect(modelPosts).toEqual([]);
    proof.historyPreserved = true;
    proof.duplicateRequests = requests;
    proof.pageErrors = errors;
  } finally {
    writeFileSync(
      testInfo.outputPath("sealed-intake", `proof-${fixture.planId}.json`),
      JSON.stringify(proof, null, 2),
    );
    await fixture.close();
  }
});

test("controlled order intake preserves legacy field rules and retains the upstream mismatch gate", async () => {
  test.setTimeout(180000);
  const fixture = await salesLaunchFixture({ pillow: true });
  try {
    const plan = await centerApi<SalesPlanDetail>(`sales-plans/${fixture.planId}`);
    await centerApi(`sales-plans/${fixture.planId}`, {
      fields: {
        ...plan.plan.fields,
        customization: {
          ...plan.plan.fields.customization,
          fields: plan.plan.fields.customization.fields.map((field) =>
            field.key === "name" && field.type === "short_text"
              ? { ...field, validation: { ...field.validation, maxLength: 10 } }
              : field,
          ),
        },
      },
      expectedRevision: plan.plan.revision,
      idempotencyKey: randomUUID(),
    });
    const legacy = await fixture.finish();
    const path = `sales-plans/${fixture.planId}/launch/delivery`;
    const delivery = await centerApi<SalesPlanDelivery>(path);
    expect(delivery.issues.some((issue) => issue.path.endsWith("customization"))).toBe(true);
    const rejectedReview = await apiFetch(`${process.env.API_BASE_URL}/v1/${path}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: delivery.revision,
        expectedFingerprint: delivery.fingerprint,
        listingVersionId: delivery.listing!.versionId,
        imageEvidence: delivery.images.map((image) => ({
          assetId: image.id,
          kind: image.main ? "finished_photo" : "mockup",
        })),
        checks: { skuFacts: true, customization: true, images: true, copyClaims: true },
        note: "Synthetic intentional field mismatch; test only, never a real approval",
        idempotencyKey: randomUUID(),
      }),
    });
    expect(rejectedReview.status).toBe(409);
    expect((await centerApi<SalesPlanDelivery>(path)).review).toBeNull();
    const account = await centerApi<MarketplaceAccountView>("marketplace-accounts", {
      platform: "amazon",
      displayName: `Synthetic mismatched intake ${fixture.planId.slice(-8)}`,
      region: "NA",
      marketplaceIds: ["ATVPDKIKX0DER"],
      authorizationMode: "amazon_private",
      requestedScopes: [],
    });
    await centerApi("product-development/channels", {
      packageId: legacy.packageId,
      accountId: account.id,
      externalSku: fixture.recipe.skuCode,
      externalListingId: "SYNTHETIC-MISMATCH-ASIN",
      effectiveFrom: new Date(Date.now() - 3600000).toISOString(),
      evidence: "Synthetic mismatch fixture",
      idempotencyKey: randomUUID(),
    });
    const batch = await centerApi<AmazonReportBatchView>("orders/reports/import", {
      accountId: account.id,
      marketplaceId: "ATVPDKIKX0DER",
      fileName: "synthetic-mismatch.txt",
      content: `order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\nMISMATCH-${fixture.planId}\tLINE\t${new Date().toISOString()}\t${fixture.recipe.skuCode}\tSynthetic pillow\t1\tUSD\t20.00`,
    });
    const imported = await centerApi<AmazonReportWorkspaceView>(
      `orders/reports/workspace?batchId=${batch.id}`,
    );
    const detail = await centerApi<OrderWorkDetail>(
      `order-centers/lines/${imported.lines[0]!.orderLineId}`,
    );
    const draft = {
      ...detail.draft,
      designExecutor: "human",
      fields: [{ key: "name", label: "Name", kind: "text", value: "Synthetic Alex" }],
    };
    const input = {
      expectedRevision: detail.line.revision,
      expectedSourceVersionId: detail.report?.versionId ?? null,
      draft,
    };
    const result = await centerApi<OrderIntakeCheck>(
      `order-centers/lines/${detail.line.id}/intake-check`,
      input,
    );
    expect(result.basis).toBe("legacy_package");
    expect(result.ready).toBe(true);
    expect(result.notes.join(" ")).toContain("不补写今天的配置");
    const invalid = {
      ...input,
      draft: { ...draft, fields: [{ ...draft.fields[0]!, value: "A".repeat(21) }] },
    };
    expect(
      (
        await centerApi<OrderIntakeCheck>(
          `order-centers/lines/${detail.line.id}/intake-check`,
          invalid,
        )
      ).issues.map((issue) => issue.code),
    ).toContain("invalid_value");
    const blocked = await apiFetch(
      `${process.env.API_BASE_URL}/v1/order-centers/lines/${detail.line.id}/draft`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...invalid,
          status: "ready_to_push",
          reason: "Synthetic rejection check",
          idempotencyKey: randomUUID(),
        }),
      },
    );
    expect(blocked.status).toBe(409);
    expect(
      (await centerApi<OrderWorkDetail>(`order-centers/lines/${detail.line.id}`)).versions,
    ).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

test.describe("controlled order intake pillow personal regressions", () => {
  test.beforeEach(async ({ page }) => {
    requireDisposableIntegrationEnvironment();
    expect(process.env.WEB_AUTH_MODE).toBe("personal");
    await loginErp(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });

  test("controlled order intake pillow saves the default Agent with the native original selected and its configured image field", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    let fixture: OrderIntakePillowFixture | undefined;
    let completed = false;
    const audit = watchPillowIntake(page, () => fixture?.lineId);
    try {
      fixture = await orderIntakePillowFixture(false);
      const whole = await openPillowIntake(page, fixture);
      await expect(whole.getByText("先由 Agent 出稿", { exact: true })).toBeVisible();
      const image = whole.locator(".oc-image").filter({ has: page.getByRole("checkbox") });
      await expect(image).toHaveCount(1);
      await expect(image.getByRole("checkbox")).toBeChecked();
      const binding = image.getByRole("combobox", { name: "对应图片字段", exact: true });
      await expect(binding).toHaveValue("buyer_photo");
      await expect(binding.locator("option:checked")).toHaveText("顾客原图（必填）");
      const check = await previewPillowIntake(page, fixture);
      expect(check.ready, JSON.stringify(check.issues)).toBe(true);
      expect(check.normalizedDraft.designExecutor).toBe("agent");
      expect(check.normalizedDraft.images).toEqual([
        { origin: "report", key: fixture.buyer.key, usage: "buyer_photo" },
      ]);
      expect(check.normalizedDraft.fields.find(field => field.key === "crop_scope")?.value)
        .toBe("head");
      expect(check.normalizedDraft.fields.find(field => field.key === "print_sides")?.value)
        .toBe("double_sided");
      assertPillowSizePreserved(check.normalizedDraft);
      await expect(whole.getByRole("combobox", { name: "设计执行方式", exact: true })).toHaveCount(0);
      const response = await savePillowIntake(page, fixture, "确认本件审单");
      expect(response.ok()).toBe(true);
      const request = response.request().postDataJSON() as {
        status: string; draft: OrderWorkDraft;
      };
      expect(request.status).toBe("ready_to_push");
      expect(request.draft.designExecutor).toBe("agent");
      const saved = OrderWorkDetailViewSchema.parse(await response.json());
      expect(saved.line.revision).toBe(fixture.initial.line.revision + 1);
      expect(saved.line).toMatchObject({
        preparation: "ready_to_push", artwork: "not_pushed",
        production: "not_released", editorProjectId: null, shippedQuantity: 0,
      });
      expect(saved.draft).toMatchObject({
        designExecutor: "agent", specificationVersionId: fixture.specificationVersionId,
        printProfileVersionId: fixture.profileVersionId, artworkVersionId: fixture.artworkVersionId,
        images: [{ origin: "report", key: fixture.buyer.key, usage: "buyer_photo" }],
      });
      expect(saved.draft.fields.find(field => field.key === "crop_scope")?.value).toBe("head");
      expect(saved.draft.fields.find(field => field.key === "print_sides")?.value).toBe("double_sided");
      assertPillowSizePreserved(saved.draft);
      expect(saved.draft.fields).toHaveLength(fixture.initial.draft.fields.length);
      expect((await fixture.readDetail()).draft).toEqual(saved.draft);
      await fixture.assertOriginalPreserved();
      expect(audit.forbiddenMutations).toEqual([]);
      expect(audit.pageErrors).toEqual([]);
      completed = true;
      await page.screenshot({ path: testInfo.outputPath("default-agent-review-saved-not-dispatched.png") });
    } finally {
      audit.stop();
      writePillowIntakeProof(testInfo, fixture, completed, "default_agent", audit);
    }
  });

  test("controlled order intake pillow preserves special requirements for Agent-first intake without a premature human switch", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    let fixture: OrderIntakePillowFixture | undefined;
    let completed = false;
    const audit = watchPillowIntake(page, () => fixture?.lineId);
    try {
      fixture = await orderIntakePillowFixture(true);
      let whole = await openPillowIntake(page, fixture);
      await expect(whole.getByText("先由 Agent 出稿", { exact: true })).toBeVisible();
      const image = whole.locator(".oc-image").filter({ has: page.getByRole("checkbox") });
      await expect(image).toHaveCount(1);
      await expect(image.getByRole("checkbox")).toBeChecked();
      const binding = image.getByRole("combobox", { name: "对应图片字段", exact: true });
      await expect(binding).toHaveValue("buyer_photo");
      await expect(binding.locator("option:checked")).toHaveText("顾客原图（必填）");
      const ready = await previewPillowIntake(page, fixture);
      expect(ready.ready, JSON.stringify(ready.issues)).toBe(true);
      expect(ready.normalizedDraft.designExecutor).toBe("agent");
      expect(ready.normalizedDraft.images).toEqual(fixture.initial.draft.images);
      assertSpecialPillowRequirements(ready.normalizedDraft);
      assertPillowSizePreserved(ready.normalizedDraft);
      await expect(whole.getByRole("button", { name: "确认本件审单", exact: true })).toBeEnabled();
      await expect(whole.getByRole("combobox", { name: "设计执行方式", exact: true })).toHaveCount(0);
      const unchanged = await fixture.readDetail();
      expect(unchanged.line.revision).toBe(fixture.initial.line.revision);
      expect(unchanged.draft).toEqual(fixture.initial.draft);
      await page.screenshot({ path: testInfo.outputPath("special-requirements-agent-first-ready.png") });
      const pendingResponse = await savePillowIntake(page, fixture, "记录待补资料");
      expect(pendingResponse.ok()).toBe(true);
      const pending = OrderWorkDetailViewSchema.parse(await pendingResponse.json());
      expect(pending.line.preparation).toBe("needs_information");
      expect(pending.line.revision).toBe(fixture.initial.line.revision + 1);
      expect(pending.draft.designExecutor).toBe("agent");
      const pendingRequest = SaveOrderWorkDraftInputSchema.parse(pendingResponse.request().postDataJSON());
      expect(pendingRequest.expectedRevision).toBe(fixture.initial.line.revision);
      expect(pendingRequest.expectedSourceVersionId).toBe(fixture.sourceVersionId);
      expect(pendingRequest.status).toBe("needs_information");
      expect(pendingRequest.draft).toEqual(fixture.initial.draft);
      expect(pending.draft).toEqual(fixture.initial.draft);
      for (const [label, value] of fixture.rawOptions)
        expect(pending.draft.fields.filter(field => field.label === label).map(field => field.value)).toEqual([value]);
      assertPillowSizePreserved(pending.draft);
      expect((await fixture.readDetail()).draft).toEqual(pending.draft);
      await fixture.assertOriginalPreserved();

      whole = await openPillowIntake(page, fixture);
      await expect(whole.getByText("先由 Agent 出稿", { exact: true })).toBeVisible();
      const current = await previewPillowIntake(page, fixture);
      expect(current.ready, JSON.stringify(current.issues)).toBe(true);
      expect(current.normalizedDraft.designExecutor).toBe("agent");
      expect(current.normalizedDraft.fields.find(field => field.key === "crop_scope")?.value).toBe("head");
      assertSpecialPillowRequirements(current.normalizedDraft);
      assertPillowSizePreserved(current.normalizedDraft);
      const finalResponse = await savePillowIntake(page, fixture, "确认本件审单");
      expect(finalResponse.ok()).toBe(true);
      const final = OrderWorkDetailViewSchema.parse(await finalResponse.json());
      expect(final.line.revision).toBe(fixture.initial.line.revision + 2);
      expect(final.line).toMatchObject({
        preparation: "ready_to_push", artwork: "not_pushed",
        production: "not_released", editorProjectId: null, shippedQuantity: 0,
      });
      expect(final.draft.designExecutor).toBe("agent");
      expect(final.draft.images).toEqual(fixture.initial.draft.images);
      expect(final.draft.fields.find(field => field.key === "crop_scope")?.value).toBe("head");
      assertSpecialPillowRequirements(final.draft);
      assertPillowSizePreserved(final.draft);
      expect(final.draft.fields).toHaveLength(fixture.initial.draft.fields.length);
      expect((await fixture.readDetail()).draft).toEqual(final.draft);
      await fixture.assertOriginalPreserved();
      const { AmazonReportDetailViewSchema } = await import("@yummyai/contracts/order/report");
      const originalReport = AmazonReportDetailViewSchema.parse(
        await centerApi("orders/reports/lines/" + fixture.reportLineId),
      );
      expect(originalReport.surfaces.flatMap(surface => surface.fields)
        .filter(field => field.label === "Pillow Shape").map(field => field.value))
        .toEqual(["Only Face"]);
      expect(originalReport.surfaces.flatMap(surface => surface.fields)
        .filter(field => field.label === "Size (Most customers choose 12/16/18/24 inch)")
        .map(field => field.value)).toEqual(["10 inch-Mini Keepsake"]);
      expect(audit.forbiddenMutations).toEqual([]);
      expect(audit.pageErrors).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath("agent-first-review-saved-requirements-preserved.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(whole).toBeVisible();
      await expect(whole.getByRole("region", { name: "顾客定制要求", exact: true })).toContainText("头部");
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await page.screenshot({ path: testInfo.outputPath("agent-first-requirements-390.png") });
      completed = true;
    } finally {
      audit.stop();
      writePillowIntakeProof(testInfo, fixture, completed, "agent_first_special_requirements_preserved", audit);
    }
  });
});

const pillowIntakeChecks = new WeakMap<Page, OrderIntakeCheck[]>();
function watchPillowIntake(page: Page, lineId: () => string | undefined) {
  const forbiddenMutations: string[] = [], pageErrors: string[] = [];
  const checks: OrderIntakeCheck[] = [];
  pillowIntakeChecks.set(page, checks);
  const request = (value: Request) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(value.method())) return;
    const pathname = new URL(value.url()).pathname;
    if (!pathname.startsWith("/api/")) return;
    if (value.method() === "POST" && (
      pathname === "/api/order-centers/summaries" ||
      pathname === "/api/order-centers/lines/" + lineId() + "/intake-check" ||
      pathname === "/api/order-centers/lines/" + lineId() + "/draft"
    )) return;
    forbiddenMutations.push(value.method() + " " + pathname);
  };
  const error = (value: Error) => pageErrors.push(value.message);
  const response = async (value: Response) => {
    if (new URL(value.url()).pathname !== "/api/order-centers/lines/" + lineId() + "/intake-check"
      || value.request().method() !== "POST" || !value.ok()) return;
    try { checks.push(OrderIntakeCheckViewSchema.parse(await value.json())); }
    catch (cause) { pageErrors.push(cause instanceof Error ? cause.message : "Invalid native intake receipt"); }
  };
  page.on("request", request); page.on("pageerror", error); page.on("response", response);
  return {
    forbiddenMutations, pageErrors,
    stop: () => { page.off("request", request); page.off("pageerror", error); page.off("response", response); pillowIntakeChecks.delete(page); },
  };
}

async function openPillowIntake(page: Page, fixture: OrderIntakePillowFixture) {
  await page.goto(fixture.url);
  const whole = page.getByRole("region", { name: "整单详情", exact: true });
  await expect(whole).toBeVisible();
  await expect(whole.getByRole("region", { name: "本单制作依据匹配", exact: true }))
    .toContainText("Synthetic intake 10 inch");
  return whole;
}

async function previewPillowIntake(page: Page, fixture: OrderIntakePillowFixture) {
  const panel = page.getByRole("region", { name: "定制订单承接核对", exact: true });
  await expect(panel.getByRole("status")).toHaveText(/^(可以确认审单|还有 \d+ 项需要处理)$/);
  await expect.poll(() => pillowIntakeChecks.get(page)?.at(-1)?.normalizedDraft.designExecutor ?? "agent")
    .toBe("agent");
  const check = pillowIntakeChecks.get(page)?.at(-1);
  expect(check).toBeDefined();
  expect(check!.orderLineId).toBe(fixture.lineId);
  expect(check!.sourceVersionId).toBe(fixture.sourceVersionId);
  return check!;
}

async function savePillowIntake(page: Page, fixture: OrderIntakePillowFixture, button: string) {
  const result = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/order-centers/lines/" + fixture.lineId + "/draft"
    && response.request().method() === "POST",
  );
  await page.getByRole("region", { name: "整单详情", exact: true })
    .getByRole("button", { name: button, exact: true }).click();
  return result;
}

function assertSpecialPillowRequirements(draft: OrderWorkDraft) {
  expect(draft.fields.find(field => field.key === "customer_notes")?.value)
    .toBe("Keep the entire synthetic head and ears");
  expect(draft.fields.find(field => field.label === "Font")?.value).toBe("Luckiest Guy");
  expect(draft.fields.find(field => field.label === "Font Color")?.value).toBe("CustomColor");
}

function assertPillowSizePreserved(draft: OrderWorkDraft) {
  expect(draft.fields
    .filter(field => field.label === "Size (Most customers choose 12/16/18/24 inch)")
    .map(field => field.value)).toEqual(["10 inch-Mini Keepsake"]);
}

function writePillowIntakeProof(
  testInfo: TestInfo, fixture: OrderIntakePillowFixture | undefined, completed: boolean,
  scenario: string, audit: ReturnType<typeof watchPillowIntake>,
) {
  const output = testInfo.outputPath("pillow-intake-proof.json");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({
    version: 1, scenario, completed, syntheticFixtureOnly: true,
    nonce: fixture?.nonce ?? null, orderLineId: fixture?.lineId ?? null,
    reportLineId: fixture?.reportLineId ?? null, sourceVersionId: fixture?.sourceVersionId ?? null,
    buyerSha256: fixture?.buyerSha256 ?? null,
    forbiddenMutations: audit.forbiddenMutations, pageErrors: audit.pageErrors,
    transport: "native report ZIP upload and parsed private original; not external download qualification",
    cleanupOwner: "native disposable runner database bucket Redis personal identity and Web sandbox finally",
    fixtureStartsProductionWorker: false, designDispatchRequested: false,
    noPersistentAttachmentAssumed: true,
  }, null, 2));
}
