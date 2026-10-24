import { expect, type Locator } from "@playwright/test";

export async function fillQualityAssessment(form: Locator, standardId: string,
  checks: Array<{ label: string; score: string; outcome: "passed" | "failed" }>) {
  await form.getByRole("combobox", { name: /^(整单质检标准|检验标准)$/ }).selectOption(standardId);
  for (const check of checks) {
    const group = form.getByRole("group", { name: "核验项目 " + check.label, exact: true });
    await expect(group).toBeVisible();
    await group.getByLabel(check.label + " 得分", { exact: true }).fill(check.score);
    await group.getByLabel(check.label + " 核验结果", { exact: true }).selectOption(check.outcome);
  }
}
