import { expect, test } from "@playwright/test";
import { createEntityId, type ProductionEditorDetailView } from "@yummyai/contracts";
import { apiFetch } from "../src/server-api";
import { createProductionDocument } from "../src/features/production-editor/production-editor-model";

test("selected projects and historical versions survive reload and deletion clears the saved location", async ({ page }) => {
  test.setTimeout(90_000);
  const projectIds: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  async function create(name: string) {
    const response = await apiFetch(`${process.env.API_BASE_URL}/v1/production-editor/projects`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, document: { ...createProductionDocument("tire_cover"), name } }),
    });
    expect(response.ok).toBe(true);
    const value = await response.json() as ProductionEditorDetailView;
    projectIds.push(value.project.id);
    return value;
  }
  const suffix = createEntityId().slice(-8);
  try {
    const first = await create(`E2E Navigation A ${suffix}`);
    const second = await create(`E2E Navigation B ${suffix}`);
    await page.goto("/pod-workbench/production-editor?kind=tire_cover");
    const selector = page.getByRole("combobox", { name: "打开生产项目", exact: true });
    const name = page.getByRole("textbox", { name: "图稿名称", exact: true });
    const versions = page.getByRole("combobox", { name: "历史版本", exact: true });
    await selector.selectOption(first.project.id);
    await expect(page).toHaveURL(new RegExp(`projectId=${first.project.id}`));
    await page.reload();
    await expect(selector).toHaveValue(first.project.id);
    await expect(name).toHaveValue(first.project.name);
    await name.fill(`E2E Navigation Latest ${suffix}`);
    await page.getByRole("button", { name: "保存新版本", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "已保存版本" })).toBeVisible();
    await versions.selectOption(first.version.id);
    await expect(page).toHaveURL(new RegExp(`versionId=${first.version.id}`));
    await page.reload();
    await expect(versions).toHaveValue(first.version.id);
    await expect(name).toHaveValue(first.project.name);
    await name.fill(`E2E Historical Copy ${suffix}`);
    await page.getByRole("button", { name: "历史副本另存新版本", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "已保存版本" })).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.has("versionId")).toBe(false);
    await page.reload();
    await expect(name).toHaveValue(`E2E Historical Copy ${suffix}`);
    await selector.selectOption(second.project.id);
    await expect(page).toHaveURL(new RegExp(`projectId=${second.project.id}`));
    await page.reload();
    await expect(selector).toHaveValue(second.project.id);
    expect(new URL(page.url()).searchParams.get("kind")).toBe("tire_cover");
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "删除项目", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.has("projectId")).toBe(false);
    await page.reload();
    await expect(selector).toHaveValue("");
    await expect(page.getByRole("button", { name: "创建生产草稿", exact: true })).toBeEnabled();
    expect(errors).toEqual([]);
  } finally {
    for (const id of projectIds.reverse()) {
      const response = await apiFetch(`${process.env.API_BASE_URL}/v1/production-editor/projects/${id}`, { method: "DELETE" });
      expect([200, 204, 404]).toContain(response.status);
    }
  }
});
