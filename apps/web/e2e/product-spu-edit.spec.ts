import { test, expect } from "@playwright/test";
import type { DevelopmentOptions } from "@yummyai/contracts/catalog/development";

test("SPU basic information edits preserve identity, retain a failed draft and survive reload on mobile", async ({ page }, info) => {
  const id = "019a0000-0000-7000-8000-000000000101";
  let spu = { id, productPlanId: "019a0000-0000-7000-8000-000000000102", code: "PET-PILLOW", name: "Pet pillow", description: "Original product description", revision: "a".repeat(64) };
  let reject = true;
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.route("**/api/product-development/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "GET" && path.endsWith("/options")) {
      const options: DevelopmentOptions = { spus: [spu], artworks: [], specifications: [], creativeVersions: [], researchItems: [], materialAssets: [], processes: [], canvasPrintSpecs: [], stockItems: [], accounts: [], preferenceScope: "synthetic-spu-edit" };
      return route.fulfill({ json: options });
    }
    if (route.request().method() === "POST" && path === `/api/product-development/spus/${id}`) {
      const body = route.request().postDataJSON();
      writes.push({ path, body });
      if (reject) return route.fulfill({ status: 409, json: { message: "SPU 基础资料已变化，请刷新后重新核对" } });
      expect(body.expectedRevision).toBe(spu.revision);
      spu = { ...spu, code: body.code, name: body.name, description: body.description, revision: "b".repeat(64) };
      return route.fulfill({ json: { spu } });
    }
    throw new Error(`Unexpected SPU fixture request: ${route.request().method()} ${path}`);
  });
  await page.goto(`/product-specifications?spu=${id}`);
  await page.getByRole("button", { name: "编辑 SPU", exact: true }).click();
  const form = page.getByRole("form", { name: "SPU 基础信息" });
  await expect(form.getByLabel("产品名称", { exact: true })).toHaveValue("Pet pillow");
  await form.getByLabel("SPU 编号", { exact: true }).fill("CUSTOM-SHAPED-PILLOW");
  await form.getByLabel("产品名称", { exact: true }).fill("定制异形抱枕");
  await form.getByLabel("产品说明", { exact: true }).fill("按人物、宠物及其他来图制作；尺寸与工艺在具体规格中维护。");
  await page.getByRole("dialog").getByRole("button", { name: "保存 SPU 基础信息", exact: true }).click();
  await expect(page.locator(".oc-error")).toContainText("基础资料已变化");
  await expect(form.getByLabel("产品名称", { exact: true })).toHaveValue("定制异形抱枕");
  reject = false;
  await page.getByRole("dialog").getByRole("button", { name: "保存 SPU 基础信息", exact: true }).click();
  await expect(page.locator(".oc-notice")).toContainText("SPU 基础信息已保存");
  await expect(page.getByRole("heading", { name: "CUSTOM-SHAPED-PILLOW · 定制异形抱枕", exact: true })).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[0]!.body.idempotencyKey).toBe(writes[1]!.body.idempotencyKey);
  expect(spu.id).toBe(id);
  await page.screenshot({ path: info.outputPath("spu-edit-desktop.png"), fullPage: true });
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "CUSTOM-SHAPED-PILLOW · 定制异形抱枕", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("spu-edit-mobile.png"), fullPage: true });
});
