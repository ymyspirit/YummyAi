import { expect, test } from "@playwright/test";
import { ErpSessionViewSchema, erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { SpecificationFactsSchema, type DevelopmentOptions, type SpecificationView } from "@yummyai/contracts/catalog/development";
import { requireStudioPersonalEnvironment } from "../../../tools/testing/require-studio-personal-environment.mjs";
import { actors, loginErp } from "./erp-identity-fixture.js";

requireStudioPersonalEnvironment(process.env, true);
if (process.env.E2E_STUDIO_CONFIGURATION_ISOLATED !== "1")
  throw new Error("SPU layout requires the isolated compiled personal configuration runner");

const id = (suffix: number) => `019f2000-0000-7000-8000-${suffix.toString(16).padStart(12, "0")}`;
const firstSpu = id(1), secondSpu = id(2), ruleId = id(90);
const longDescription = "合成商品长说明仅用于布局验收 不构成生产事实\n" + "SyntheticOriginalProductExplanation".repeat(20);
function optionsFor(session: ErpSessionView): DevelopmentOptions {
  const specifications: SpecificationView[] = [20, 12, 24, 10, 22, 14, 18, 16].map(size => ({
    id: id(100 + size), versionId: id(200 + size), version: 4, spuId: firstSpu, spuCode: "SYNTHETIC-PILLOW", spuName: "合成异形抱枕",
    code: `CP-${size}`, name: `${size} 英寸`, attributes: { 尺寸: `${size} 英寸` },
    facts: SpecificationFactsSchema.parse({ formatVersion: 2, material: "Synthetic original material evidence", structure: "Synthetic original two-panel construction evidence",
      dimensions: `${size} in · 图案主体最长边`, physicalDimensions: { basis: "artwork_longest", unit: "in", length: size, width: null, height: null },
      packageContents: "One synthetic pillow", packageQuantity: 1, factsConfirmed: false, productionConfirmed: true,
      weightGrams: null, packagedWeightGrams: size === 12 ? null : 123.456789, packageDimensions: "30 × 20 × 5 cm",
      packageMeasurements: { unit: "cm", length: 30, width: 20, height: 5 }, verificationReference: `Synthetic original measurement ${size}`,
      productionRuleReferences: [{ ruleId, versionId: id(91), version: 3 }] }),
    factVerification: null, productionVerification: { confirmedByUserId: session.userId, confirmedAt: "2026-10-30T00:00:00.000Z", reference: `Synthetic pinned production proof ${size}` },
    processProfileVersionId: size === 24 ? null : id(92), processName: "Synthetic reviewed process", productType: "shaped_pillow",
    canvasPrintSpecVersionId: null, stockItemId: null, createdAt: "2026-10-30T00:00:00.000Z",
  }));
  specifications.push({ ...specifications[0]!, id: id(330), versionId: id(430), spuId: secondSpu, spuCode: "SYNTHETIC-SECOND", spuName: "合成第二商品", code: "SECOND-30", name: "30 英寸" });
  return { contextAuthority: erpSessionAuthority(session), preferenceScope: `${session.tenantId}:${session.userId}`,
    artworks: [], specifications, spus: [
      { id: firstSpu, code: "SYNTHETIC-PILLOW", name: "合成异形抱枕", productPlanId: id(10), ownerUserId: session.userId, description: longDescription, revision: "a".repeat(64),
        capabilities: { processes: "Synthetic process instructions", customizationScope: "Synthetic customer-photo customization scope", packaging: "Synthetic packaging instructions" } },
      { id: secondSpu, code: "SYNTHETIC-SECOND", name: "合成第二商品", productPlanId: id(11), ownerUserId: session.userId, description: "Synthetic second product", revision: "b".repeat(64) },
    ], creativeVersions: [], researchItems: [], processes: [{ versionId: id(92), code: "SYNTHETIC-PROCESS", name: "Synthetic reviewed process", productType: "shaped_pillow" }],
    canvasPrintSpecs: [], stockItems: [], accounts: [], materialAssets: [] };
}

for (const viewport of [{ label: "desktop", width: 1440, height: 960 }, { label: "mobile", width: 390, height: 844 }]) {
  test(`personal SPU summary, evidence and original specification edit work at ${viewport.label} width`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await loginErp(page, "operator", "/content-projects");
    const read = await page.request.get("/api/erp-auth/session");
    expect(read.status()).toBe(200);
    const session = ErpSessionViewSchema.parse(await read.json());
    expect(session.userId).toBe(actors().operator.userId);
    expect(session.tenantId).toBe(actors().operator.tenantId);
    expect(session.permissions).toEqual(expect.arrayContaining(["product:read", "product:write"]));
    const source = optionsFor(session), original = structuredClone(source), unexpectedWrites: string[] = [];
    let optionReads = 0;
    page.on("request", request => { const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/") && !path.startsWith("/api/erp-auth/") && request.method() !== "GET") unexpectedWrites.push(path);
    });
    // Only this options DTO belongs to the test. Identity, compiled rendering,
    // permission checks and navigation remain real; this does not test API data isolation.
    try {
      await page.route("**/api/product-development/options", async route => {
        expect(route.request().method()).toBe("GET");
        const currentRead = await page.request.get("/api/erp-auth/session");
        expect(currentRead.status()).toBe(200);
        const current = ErpSessionViewSchema.parse(await currentRead.json());
        expect(erpSessionAuthority(current)).toBe(source.contextAuthority);
        expect(current.permissions).toContain("product:read");
        optionReads++;
        await route.fulfill({ status: 200, headers: { "cache-control": "private, no-store", "x-yummyai-context-authority": erpSessionAuthority(current) }, json: source });
      });
      const query = new URLSearchParams({ spu: firstSpu, queue: `${firstSpu},${secondSpu}` });
      await page.goto(`/product-specifications?${query}`);
      const dialog = page.getByRole("dialog", { name: "SYNTHETIC-PILLOW · 合成异形抱枕", exact: true });
      await expect(dialog).toBeVisible();
      const table = dialog.getByRole("table", { name: "产品规格对比", exact: true });
      const rows = table.locator("tbody tr").filter({ has: page.getByRole("button", { name: "修改规格", exact: true }) });
      await expect(rows).toHaveCount(8);
      for (const [index, size] of [10, 12, 14, 16, 18, 20, 22, 24].entries()) {
        await expect(rows.nth(index).getByRole("rowheader")).toContainText(`${size} 英寸`);
        await expect(rows.nth(index)).toContainText("V4");
      }
      if (viewport.label === "desktop") {
        await expect(table.getByRole("columnheader", { name: "含包装重量", exact: true })).toBeVisible();
        await expect(table.getByRole("columnheader", { name: "包装外尺寸", exact: true })).toBeVisible();
      } else {
        await expect(rows.first().locator('[data-label="含包装重量"]')).toBeVisible();
        await expect(rows.first().locator('[data-label="包装外尺寸"]')).toBeVisible();
        for (const target of [
          { name: "筛选规格", control: dialog.getByLabel("筛选规格", { exact: true }) },
          { name: "编辑 SPU", control: dialog.locator(".task-drawer-footer button.spu-detail-button").filter({ hasText: /^编辑 SPU$/ }) },
          { name: "绑定多个规格", control: dialog.locator(".task-drawer-footer button.spu-detail-button").filter({ hasText: /^绑定多个规格$/ }) },
        ]) {
          await expect(target.control).toBeVisible();
          const bounds = await target.control.evaluate(element => {
            const { width, height } = element.getBoundingClientRect();
            return { width, height };
          });
          expect(bounds.height, `${target.name} mobile touch height`).toBeGreaterThanOrEqual(44);
          expect(bounds.width, `${target.name} mobile touch width`).toBeGreaterThanOrEqual(44);
        }
      }
      await expect(rows.nth(0)).toContainText("123.46 g");
      await expect(rows.nth(1)).toContainText("待确认");
      const description = dialog.locator("details").filter({ has: page.locator("summary").filter({ hasText: /^产品说明与通用工艺$/ }) });
      await expect(description).toHaveJSProperty("open", false);
      await expect(description.getByText("合成商品长说明仅用于布局验收", { exact: false })).toBeHidden();
      const firstToggle = dialog.getByRole("button", { name: "10 英寸 完整资料与核验依据", exact: true });
      const evidence = dialog.getByRole("region", { name: "10 英寸 完整资料", exact: true });
      await expect(firstToggle).toHaveAttribute("aria-expanded", "false");
      await expect(evidence).toBeHidden();
      await page.screenshot({ path: testInfo.outputPath(`spu-summary-${viewport.label}.png`) });
      await description.locator("summary").click();
      await expect(description.getByText("合成商品长说明仅用于布局验收", { exact: false })).toBeVisible();
      await firstToggle.click();
      await expect(firstToggle).toHaveAttribute("aria-expanded", "true");
      await expect(evidence).toBeVisible();
      for (const text of ["Synthetic original material evidence", "Synthetic original two-panel construction evidence", "123.456789", "Synthetic original measurement 10", "Synthetic pinned production proof 10"])
        await expect(evidence).toContainText(text);
      await expect(evidence.getByText("商品净重 原始记录", { exact: true }).locator("..").getByText("未知", { exact: true })).toBeVisible();
      const rule = evidence.getByRole("link", { name: "查看原规则 · V3", exact: true });
      const ruleUrl = new URL(await rule.getAttribute("href") ?? "", page.url());
      expect(ruleUrl.searchParams.get("rule")).toBe(ruleId); expect(ruleUrl.searchParams.get("version")).toBe("3");
      expect(new URL(ruleUrl.searchParams.get("returnTo")!, page.url()).pathname).toBe("/product-specifications");
      await page.screenshot({ path: testInfo.outputPath(`spu-evidence-${viewport.label}.png`) });
      expect(await page.locator("html").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);

      const filter = dialog.getByLabel("筛选规格", { exact: true });
      await filter.fill("CP-16"); await expect(rows).toHaveCount(1); await expect(rows.first()).toContainText("16 英寸");
      await filter.fill("no-synthetic-match"); await expect(rows).toHaveCount(0);
      await expect(dialog.getByText("没有匹配的规格 请调整筛选条件", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "下一条", exact: true }).click();
      const second = page.getByRole("dialog", { name: "SYNTHETIC-SECOND · 合成第二商品", exact: true });
      await expect(second).toBeVisible(); await expect(second.getByLabel("筛选规格", { exact: true })).toHaveValue("");
      await expect(second.getByRole("table", { name: "产品规格对比", exact: true }).getByRole("rowheader")).toContainText("30 英寸");
      await expect(second.getByRole("button", { name: "30 英寸 完整资料与核验依据", exact: true })).toHaveAttribute("aria-expanded", "false");
      await second.getByRole("button", { name: "上一条", exact: true }).click();
      await expect(dialog).toBeVisible(); await expect(filter).toHaveValue(""); await expect(rows).toHaveCount(8);
      await expect(description).toHaveJSProperty("open", false); await expect(firstToggle).toHaveAttribute("aria-expanded", "false");
      await rows.first().getByRole("button", { name: "修改规格", exact: true }).click();
      const editor = page.getByRole("dialog", { name: "修改规格 · 创建新版本", exact: true });
      await expect(editor).toBeVisible();
      const first = source.specifications.find(spec => spec.code === "CP-10")!;
      expect(new URL(page.url()).searchParams.get("specificationVersionId")).toBe(first.versionId);
      await expect(editor.getByLabel("规格编号", { exact: true })).toHaveValue(first.code);
      await expect(editor.getByLabel("规格名称", { exact: true })).toHaveValue(first.name);
      await expect(editor.getByLabel("商品净重（克）", { exact: true })).toHaveValue("");
      await expect(editor.getByLabel("含包装重量（克）", { exact: true })).toHaveValue("123.456789");
      expect(source).toEqual(original); expect(optionReads).toBeGreaterThan(0); expect(unexpectedWrites).toEqual([]);
    } finally {
      // Finish in-flight session checks before Playwright tears down the page request context.
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}
