import { expect, test } from "@playwright/test";
import { createEntityId } from "@yummyai/contracts";

const workbenches = [
  {
    heading: "画图设计",
    path: "/creative-designs",
    boundary: "授权素材",
    emptyState: "建立第一批创意需求",
    nextPath: "/pod-workbench/mockup-batches",
  },
  {
    heading: "批量套图",
    path: "/pod-workbench/mockup-batches",
    boundary: "正式设计",
    emptyState: "等待第一批正式设计",
    nextPath: "/creative-designs",
  },
] as const;

for (const workbench of workbenches) {
  test(`${workbench.heading} exposes its production boundary and responsive shell`, async ({
    page,
  }) => {
    await page.goto(workbench.path);

    await expect(page.getByRole("heading", { name: workbench.heading, level: 1 })).toBeVisible();
    await expect(page.getByText(workbench.boundary, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: workbench.emptyState })).toBeVisible();
    await expect(page.locator('a[href="/creative-designs"]').first()).toBeVisible();
    await expect(page.locator('a[href="/pod-workbench/mockup-batches"]').first()).toBeVisible();
    await expect(page.locator(`a[href="${workbench.nextPath}"]`).first()).toBeVisible();

    const creativeNavigation = page.locator('[aria-labelledby="rail-group-creative"]');
    await expect(creativeNavigation.getByRole("link")).toHaveCount(4);
    for (const label of ["画图设计", "POD 作图中心", "设计校样", "批量套图"]) {
      await expect(creativeNavigation.getByRole("link", { name: label })).toBeVisible();
    }

    if (workbench.path === "/creative-designs") {
      const header = "row_key,name,prompt,negative_prompt,reference_asset_ids,candidate_count,print_spec_version_ids";
      const csvInput = page.locator('input[type="file"][accept*="csv"]');
      await csvInput.setInputFiles({
        buffer: Buffer.from(`${header}\ne2e-row,E2E 帆布画,quiet coastal sunrise,,,4,${createEntityId()}`),
        mimeType: "text/csv",
        name: "canvas-designs.csv",
      });
      await expect(page.getByLabel("第 1 行键")).toHaveValue("e2e-row");
      await expect(page.getByLabel("第 1 名称")).toHaveValue("E2E 帆布画");
      await expect(page.getByLabel("第 1 候选数量")).toHaveValue("4");

      await csvInput.setInputFiles({
        buffer: Buffer.from(`${header},surprise\ne2e-row,E2E 帆布画,quiet coastal sunrise,,,2,${createEntityId()},x`),
        mimeType: "text/csv",
        name: "invalid-canvas-designs.csv",
      });
      await expect(page.getByText("未知列：surprise")).toHaveText("未知列：surprise");
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await expect(page.getByRole("heading", { name: workbench.heading, level: 1 })).toBeVisible();
  });
}

test("legacy batch-design URL redirects to the independent creative workspace", async ({ page }) => {
  const batchId = createEntityId();
  await page.goto(`/pod-workbench/batch-designs?batch=${batchId}`);
  await expect(page).toHaveURL(`/creative-designs?batch=${batchId}`);
  await expect(page.getByRole("heading", { name: "画图设计", level: 1 })).toBeVisible();
});
