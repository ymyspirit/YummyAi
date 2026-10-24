import type { RuleFields, RuleRow, RuleWorkspace } from "@yummyai/contracts/rules";
import { workflowHref } from "../navigation/workflow-href";

export const PRODUCT_NAMES = { shaped_pillow: "异形抱枕", tire_cover: "备胎罩", rectangular_print: "矩形印花" } as const;
export const EMPTY_RULE: RuleFields = { name: "", category: "general", instructions: "", source: "", scopeKind: "all", productType: null, spuId: null, appliesTo: "order_design" };
export const CATEGORY_TITLES = { production: "工艺与交付", ai_workflow: "图片处理", acceptance: "验收与审核", general: "通用要求" } as const;
export function scopeLabel(rule: RuleFields, data: RuleWorkspace) {
  return rule.scopeKind === "all" ? "全部商品" : rule.scopeKind === "product_type"
    ? PRODUCT_NAMES[rule.productType!] : data.spus.find(item => item.id === rule.spuId)?.name ?? "指定商品（已归档）";
}
export function statusLabel(row: RuleRow) {
  return row.activeVersion ? "已启用 V" + row.activeVersion + (row.activeVersion !== row.latestVersion ? " · 草稿 V" + row.latestVersion : "")
    : "未启用 · 草稿 V" + row.latestVersion;
}
export function viewLabel(view: string, data: RuleWorkspace) {
  if (view === "all") return "全部规则";
  if (view === "general") return "通用制作要求";
  if (view === "operations") return "日常操作规范";
  if (view.startsWith("spu:")) return data.spus.find(item => item.id === view.slice(4))?.name ?? "指定商品";
  return PRODUCT_NAMES[view as keyof typeof PRODUCT_NAMES] ?? "通用制作要求";
}
function definitionInView(rule: RuleFields, view: string, data: RuleWorkspace) {
  if (view === "all") return true;
  if (view === "operations") return rule.appliesTo === "operations";
  if (rule.appliesTo !== "order_design") return false;
  if (view === "general") return rule.scopeKind === "all";
  if (rule.scopeKind === "all") return true;
  if (view.startsWith("spu:")) {
    const spuId = view.slice(4);
    const product = data.spus.find(item => item.id === spuId);
    return rule.scopeKind === "spu" ? rule.spuId === spuId
      : !!rule.productType && !!product?.productTypes.includes(rule.productType);
  }
  return rule.scopeKind === "product_type" && rule.productType === view;
}
export function ruleInView(row: RuleRow, view: string, data: RuleWorkspace) {
  // A draft changing scope remains discoverable in its still-active scope.
  return definitionInView(row.latest, view, data) || !!row.active && definitionInView(row.active, view, data);
}
export function newRuleForView(view: string): RuleFields {
  if (view === "operations") return { ...EMPTY_RULE, appliesTo: "operations" };
  if (view.startsWith("spu:")) return { ...EMPTY_RULE, scopeKind: "spu", spuId: view.slice(4) };
  if (view in PRODUCT_NAMES) return { ...EMPTY_RULE, scopeKind: "product_type", productType: view as RuleFields["productType"] };
  return { ...EMPTY_RULE };
}
export function configurationFor(row: RuleRow) {
  if (row.latest.binding === "pillow_factory") return { label: "前往工艺底稿", href: "/process-library",
    description: "尺寸、白边、裁剪线和排版参数在商品的工艺底稿中维护，修改后保存并审核新版本。" };
  if (row.latest.binding === "faithful_enhancement" || row.code === "system:pillow-model") return { label: "配置制图流程", href: "/process-library",
    description: "在商品底稿的“自动制图配方”中选择图片处理方式和图像模型，保存并审核后供新订单使用。" };
  return null;
}
export function configHref(row: RuleRow, path: string) {
  return workflowHref(path, "/settings/rules?rule=" + row.id);
}
export type RuleSelection = { id: string; edit?: boolean; version?: number; fields?: RuleFields };
