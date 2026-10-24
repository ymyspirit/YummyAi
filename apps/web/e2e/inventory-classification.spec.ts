import { expect, test } from "@playwright/test";
import { Permission } from "@yummyai/authz";
import { loginErp, changeErpRights } from "./erp-identity-fixture";

test("personal inventory classification preserves original stock, drafts, history and current read-only access", async ({ page }, info) => {
  test.setTimeout(120_000);
  const name = `Synthetic classified fabric ${crypto.randomUUID().slice(0, 8)}`, errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 }); await loginErp(page, "operator", "/inventory");
  await page.getByRole("button", { name: "新增物料", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新增物料", exact: true });
  await create.getByLabel("物料名称", { exact: true }).fill(name);
  const code = await create.getByLabel("物料编码", { exact: true }).inputValue();
  await create.getByLabel("物料分类", { exact: true }).selectOption("blank");
  await create.getByLabel("库存单位", { exact: true }).selectOption("meter");
  await create.getByRole("button", { name: "保存物料", exact: true }).click(); await expect(create).toHaveCount(0);
  const records = page.locator(".record-master-list"), row = records.locator("tbody tr").filter({ hasText: name });
  async function openHistory() {
    await expect(row).toBeAttached();
    if (!await records.evaluate(element => (element as HTMLDetailsElement).open)) await records.locator("summary").click();
    await row.getByRole("button", { name: `分类与历史 ${name}`, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `物料分类 · ${name}`, exact: true });
    await expect(dialog.locator(".stock-classification-history")).toBeVisible(); return dialog;
  }
  let dialog = await openHistory(); await expect(dialog.locator(".stock-classification-summary")).toContainText("坯料 · v1");
  const reason = "Synthetic checked packaging classification with a long source description ".repeat(8).trim();
  await dialog.getByLabel("物料分类", { exact: true }).selectOption("packaging");
  await dialog.getByLabel("分类说明", { exact: true }).fill(reason);
  await dialog.getByRole("button", { name: "保存分类", exact: true }).click(); await expect(dialog).toHaveCount(0);
  dialog = await openHistory(); await expect(dialog.locator(".stock-classification-summary")).toContainText("包装 · v2");
  await expect(dialog.locator(".stock-classification-history li")).toHaveCount(2); await expect(dialog).toContainText(reason);
  await expect(row).toContainText(code); await expect(row).toContainText("米");
  await page.screenshot({ path: info.outputPath("stock-classification-history-desktop.png"), fullPage: true, animations: "disabled" });
  await dialog.getByLabel("分类说明", { exact: true }).fill("Synthetic unsaved revised basis");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(dialog.getByLabel("分类说明", { exact: true })).toHaveValue("Synthetic unsaved revised basis");
  await page.setViewportSize({ width: 390, height: 844 });
  const layout = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth,
    offenders: [...document.querySelectorAll("main > *, dialog, dialog > *")].map(element => ({ element: element.tagName, className: element.className,
      left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right })).filter(element => element.right > innerWidth + 1 || element.left < -1) }));
  expect(layout, "The page and classification dialog must fit the mobile viewport").toMatchObject({ offenders: [] });
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.width + 1);
  await page.screenshot({ path: info.outputPath("stock-classification-history-mobile.png"), fullPage: true, animations: "disabled" });
  page.once("dialog", modal => modal.accept()); await dialog.getByRole("button", { name: "取消", exact: true }).click(); await expect(dialog).toHaveCount(0);
  try {
    dialog = await openHistory();
    await dialog.getByLabel("分类说明", { exact: true }).fill("Synthetic private draft revoked during submission");
    await changeErpRights("operator", Object.values(Permission).filter(permission => permission !== Permission.InventoryWrite));
    // No focus refresh: the actual submission must clear the private draft on denial.
    await dialog.getByRole("button", { name: "保存分类", exact: true }).click();
    await expect(dialog.getByLabel("分类说明", { exact: true })).toHaveCount(0);
    await expect(dialog).toContainText("已清除本次填写");
    await expect(dialog.locator(".stock-classification-history")).toHaveCount(0);
    await dialog.getByRole("button", { name: `关闭物料分类 · ${name}`, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const navigation = page.waitForEvent("framenavigated", { predicate: frame => frame === page.mainFrame() });
    await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await navigation;
    dialog = await openHistory(); await expect(dialog).toContainText("当前只有分类读取权限");
    await expect(dialog.getByRole("button", { name: "保存分类", exact: true })).toHaveCount(0);
    await expect(dialog.locator(".stock-classification-history li")).toHaveCount(2);
  } finally { await changeErpRights("operator", Object.values(Permission)); }
  expect(errors).toEqual([]);
});
