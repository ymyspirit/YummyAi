import { expect, type Locator } from "@playwright/test";

export async function executePreparedIncoming(dialog: Locator, options: { keepResult?: boolean } = {}) {
  await dialog.getByRole("button", { name: "保存原填写并核对", exact: true }).click();
  await confirmIncomingOriginal(dialog, options);
}
export async function confirmIncomingOriginal(dialog: Locator, options: { keepResult?: boolean } = {}) {
  const original = dialog.getByRole("region", { name: "核对原提交", exact: true });
  await expect(original).toContainText("待核对执行");
  await original.getByLabel("我已核对原填写与本次实际业务依据", { exact: true }).check();
  await original.getByRole("button", { name: "确认执行原提交", exact: true }).click();
  await expect(original).toContainText("实际业务结果已保存");
  if (!options.keepResult) await acknowledgeIncoming(dialog);
}
export async function acknowledgeIncoming(dialog: Locator) {
  const original = dialog.getByRole("region", { name: "核对原提交", exact: true });
  await original.getByRole("button", { name: "确认结果并清除填写副本", exact: true }).click();
  await expect(original).toHaveCount(0);
}
export async function publishIncomingStandard(dialog: Locator, stockId: string, title: string) {
  await dialog.getByRole("button", { name: "发布检验标准", exact: true }).click();
  const form = dialog.locator("form.incoming-form");
  await form.getByLabel("原物料", { exact: true }).selectOption(stockId);
  await form.getByLabel("标准编号", { exact: true }).fill("SYNTHETIC");
  await form.getByLabel("标准名称", { exact: true }).fill(title);
  await form.getByLabel("实际标准来源与版本", { exact: true }).fill("Isolated synthetic browser observations only No actual factory or supplier acceptance");
  await form.getByLabel("项目编号", { exact: true }).fill("OBSERVATION");
  await form.getByLabel("项目名称", { exact: true }).fill("实际外观观测");
  await form.getByLabel("判定方式", { exact: true }).selectOption("one_of");
  await form.getByLabel("符合要求的观测值", { exact: true }).fill("SYNTHETIC-RECORDED");
  await executePreparedIncoming(dialog);
}
export async function fillIncomingArrival(dialog: Locator, locationId: string, quantity: string, lot: string, reference: string) {
  await dialog.getByRole("button", { name: "登记实际到货", exact: true }).click();
  const form = dialog.locator("form.incoming-form");
  await form.getByLabel("实际到货时间", { exact: true }).fill("2026-10-19T02:00");
  await form.getByLabel("实际交接凭据", { exact: true }).fill(reference);
  await form.locator('input[name="quantity-0"]').fill(quantity);
  await form.getByLabel("实际待检保管库位", { exact: true }).selectOption(locationId);
  await form.getByLabel("供应商原批号", { exact: true }).fill(lot);
}
export async function inspectIncoming(dialog: Locator, accepted: string, rejected = "0", sample = "1", reinspection = false) {
  await dialog.getByRole("button", { name: reinspection ? "记录本次复检" : "记录实际检验", exact: true }).click();
  const form = dialog.locator("form.incoming-form");
  const standard = await form.getByLabel("实际使用的标准", { exact: true }).locator('option:not([value=""])').first().getAttribute("value");
  await form.getByLabel("实际使用的标准", { exact: true }).selectOption(standard!);
  await form.getByLabel("实际测量或观测值", { exact: true }).fill("SYNTHETIC-RECORDED");
  await form.locator('input[name="accepted"]').fill(accepted);
  await form.locator('input[name="rejected"]').fill(rejected);
  await form.locator('input[name="sample"]').fill(sample);
  if (rejected !== "0") await form.getByLabel("实际拒收原因", { exact: true }).fill("Synthetic damaged portion");
  await form.getByLabel("实际测量时间", { exact: true }).fill("2026-10-19T02:01");
  if (reinspection) await form.getByLabel("本次复检原因", { exact: true }).fill("Synthetic actual remaining portion checked");
  await executePreparedIncoming(dialog);
}
export async function reviewIncoming(dialog: Locator) {
  await dialog.getByRole("button", { name: "核准本次检验", exact: true }).click();
  const form = dialog.locator("form.incoming-form");
  await form.getByLabel("本次核准决定", { exact: true }).selectOption("approved");
  await form.getByLabel("核准依据", { exact: true }).fill("Synthetic actual observations reviewed");
  await executePreparedIncoming(dialog);
}
export async function fillIncomingPosting(dialog: Locator, accepted: string, rejected = "0", rejectionLocation?: string) {
  await dialog.getByRole("button", { name: "确认检验入账", exact: true }).click();
  const form = dialog.locator("form.incoming-form");
  await form.locator('input[name="accepted"]').fill(accepted);
  await form.locator('input[name="rejected"]').fill(rejected);
  if (rejectionLocation) await form.getByLabel("实际拒收保管库位", { exact: true }).selectOption(rejectionLocation);
  if (accepted !== "0") await form.getByLabel("确认本次接受物料已由商家实际接收并拥有", { exact: true }).check();
  await form.getByLabel("实际入账时间", { exact: true }).fill("2026-10-19T02:02");
}
