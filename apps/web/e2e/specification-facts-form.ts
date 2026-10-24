import type { Locator } from "@playwright/test";

export async function fillSpecificationFacts(form: Locator, options: {
  prefix?: string; basis?: "artwork_longest" | "diameter"; length?: string;
} = {}) {
  const prefix = options.prefix ?? "", basis = options.basis ?? "artwork_longest";
  await form.getByLabel(prefix + "实际材质", { exact: true }).fill("Synthetic measured fabric");
  await form.getByLabel(prefix + "产品结构", { exact: true }).fill("Synthetic verified construction");
  await form.getByLabel(prefix + "尺寸口径", { exact: true }).selectOption(basis);
  await form.getByLabel(prefix + "尺寸单位", { exact: true }).selectOption("mm");
  await form.getByLabel(prefix + (basis === "diameter" ? "实际直径" : "图案主体最长边"), { exact: true }).fill(options.length ?? "254");
  await form.getByLabel(prefix + "商品重量（克）", { exact: true }).fill("200");
  await form.getByLabel(prefix + "含包装重量（克）", { exact: true }).fill("250");
  await form.getByLabel(prefix + "包装内包含", { exact: true }).fill("One synthetic item");
  await form.getByLabel(prefix + "每份件数", { exact: true }).fill("1");
  await form.getByLabel(prefix + "包装尺寸单位", { exact: true }).selectOption("mm");
  await form.getByLabel(prefix + "包装长度", { exact: true }).fill("300");
  await form.getByLabel(prefix + "包装宽度", { exact: true }).fill("300");
  await form.getByLabel(prefix + "包装高度", { exact: true }).fill("100");
  await form.getByLabel(prefix + "核验依据", { exact: true }).fill("Synthetic measurement sheet; disposable acceptance only");
}
