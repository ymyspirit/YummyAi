import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  type AmazonReportBatchView,
  type AmazonReportWorkspaceView,
  type MarketplaceAccountView,
} from "@yummyai/contracts";
import {
  OrderIntakeCheckViewSchema,
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

test("controlled order intake preserves sealed configuration, blocks mismatches and resumes corrected orders", async ({
  page,
}) => {
  test.setTimeout(300000);
  page.setDefaultTimeout(25000);
  const fixture = await salesLaunchFixture({ pillow: true, orderIntake: true });
  const proofDir = new URL("../../../tmp/order-intake-e2e/", import.meta.url);
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
    await page.goto(`/orders?q=${externalIds[0]}`);
    await page.getByRole("button", { name: externalIds[0], exact: true }).click();
    const region = page.getByRole("region", { name: "定制订单承接核对", exact: true });
    await region.getByRole("button", { name: "核对当前需求" }).click();
    await expect(region).toContainText("请补齐必填定制内容：Portrait");
    await page.getByRole("combobox", { name: "对应定制字段", exact: true }).selectOption("name");
    await expect(page.getByLabel("字段名称", { exact: true })).toHaveValue("Name");
    await expect(page.getByLabel("定制内容", { exact: true })).toHaveValue("Synthetic Alex");
    await page
      .getByRole("combobox", { name: "销售 SKU 制作版本", exact: true })
      .selectOption(sibling.recipe.id);
    await region.getByRole("button", { name: "核对当前需求" }).click();
    await expect(region).toContainText("本单渠道已有封存定制资料");
    await page.getByRole("button", { name: "使用下单时渠道映射", exact: true }).click();
    await expect(
      page.getByRole("combobox", { name: "销售 SKU 制作版本", exact: true }),
    ).toHaveValue(fixture.recipe.id);
    await page.getByRole("checkbox", { name: "synthetic-buyer-original.png", exact: true }).check();
    await page.getByLabel("制作用途", { exact: true }).fill("Portrait");
    await expect(region).toContainText("需求或订单状态已变化");
    await region.getByRole("button", { name: "核对当前需求" }).click();
    await expect(region).toContainText("字段与版本核对通过");
    await region.getByRole("button", { name: "应用唯一字段匹配" }).click();
    await region.getByRole("button", { name: "核对当前需求" }).click();
    await expect(region).toContainText("字段与版本核对通过");
    await page.getByText("处理与交接", { exact: true }).click();
    const requests: string[] = [];
    let drop = true;
    await page.route(`**/api/order-centers/lines/${first.line.id}/draft`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      requests.push(route.request().postDataJSON().idempotencyKey);
      const response = await route.fetch();
      if (drop && response.ok()) {
        drop = false;
        return route.abort("failed");
      }
      return route.fulfill({ response });
    });
    const saveButton = page.getByRole("button", { name: "确认审单并保存", exact: true });
    await saveButton.click();
    await expect
      .poll(
        async () =>
          (await centerApi<OrderWorkDetail>(`order-centers/lines/${first.line.id}`)).line.revision,
      )
      .toBe(first.line.revision + 1);
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(
      page.getByRole("status").filter({ hasText: "审单已保存，可以推送制图" }),
    ).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
    first = await centerApi<OrderWorkDetail>(`order-centers/lines/${first.line.id}`);
    expect(first.versions).toHaveLength(2);
    expect(first.draft.fields[0]!.key).toBe("name");
    expect(first.draft.images[0]!.usage).toBe("portrait");
    await region.getByRole("button", { name: "核对当前需求" }).click();
    await expect(region).toContainText("字段与版本核对通过");
    await region.getByText("查看本单固定版本引用", { exact: true }).click();
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
        path: new URL(`${name}.png`, proofDir).pathname.replace(/^\/(.:)/, "$1"),
      });
      await page.screenshot({
        path: new URL(`page-${name}.png`, proofDir).pathname.replace(/^\/(.:)/, "$1"),
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
      new URL(`proof-${fixture.planId}.json`, proofDir),
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
