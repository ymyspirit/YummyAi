import { expect, type Locator, type Page } from "@playwright/test";
import { ProcurementCommandViewSchema } from "@yummyai/contracts/procurement/procurement-command";

export async function procurementCommandDialog(page: Page, formName?: string) {
  const dialog = page.getByRole("dialog", { name: "采购原填写与执行", exact: true });
  await expect(dialog).toBeVisible();
  if (formName) await expect(dialog.getByRole("form", { name: formName, exact: true })).toBeVisible();
  return dialog;
}

export async function prepareProcurementOriginal(dialog: Locator) {
  await dialog.getByRole("button", { name: "保存原填写并核对", exact: true }).click();
  const original = dialog.getByRole("region", { name: "核对采购原提交", exact: true });
  await expect(original).toBeVisible();
  await expect(original.getByRole("button", { name: "确认执行原提交", exact: true })).toBeDisabled();
  return original;
}

export async function executeProcurementOriginal(dialog: Locator) {
  const original = dialog.getByRole("region", { name: "核对采购原提交", exact: true });
  await original.getByLabel("我已核对原填写与本次采购依据", { exact: true }).check();
  await original.getByRole("button", { name: "确认执行原提交", exact: true }).click();
  await expect(original.getByRole("status")).toContainText("实际操作已完成");
  return original;
}

export async function acknowledgeProcurementOriginal(dialog: Locator) {
  const acknowledged = dialog.page().waitForResponse(response =>
    /^\/api\/procurement-commands\/commands\/[0-9a-f-]+\/acknowledge$/.test(new URL(response.url()).pathname)
    && response.request().method() === "POST");
  await dialog.getByRole("region", { name: "核对采购原提交", exact: true })
    .getByRole("button", { name: "确认结果并清除填写副本", exact: true }).click();
  const response = await acknowledged;
  expect(response.status()).toBe(200);
  const actual = ProcurementCommandViewSchema.parse(await response.json());
  expect(actual.acknowledged).toBe(true);
  expect(actual.original).toBeNull();
  await expect(dialog).toHaveCount(0);
}

export async function submitProcurementOriginal(dialog: Locator) {
  await prepareProcurementOriginal(dialog);
  await executeProcurementOriginal(dialog);
  await acknowledgeProcurementOriginal(dialog);
}
