import { OrderRuleSnapshotSchema } from "@yummyai/contracts/rules";
import { SHAPED_PILLOW_FACTORY_STANDARD } from "@yummyai/contracts/pod/production-editor";
import { DesignAutomationRecipeSchema } from "@yummyai/contracts/pod/design-automation";
import type { OrderDesignSnapshot } from "./types.js";

/** A small trusted binding registry. User text is review material, never executable instructions. */
export function pinnedRuleDiagnostics(snapshot: OrderDesignSnapshot) {
  const diagnostics: Array<{ code: string; severity: "error" | "manual" | "warning"; message: string }> = [];
  if (!snapshot.ruleSnapshot) return diagnostics;
  const pinned = OrderRuleSnapshotSchema.parse(snapshot.ruleSnapshot);
  for (const rule of pinned.rules) {
    // Snapshot execution status is immutable. New code must not upgrade a pinned
    // manual/unavailable rule just because a binding gained implementation.
    if (rule.execution !== "automatic") {
      diagnostics.push({ code: `rule_${rule.execution}`, severity: "manual", message: `${rule.execution === "unavailable" ? "尚未接入，需核对处理" : "人工核验"}：${rule.name}（V${rule.version}）。详见本任务固定规则。` });
    } else if (rule.binding === "pillow_pipeline_v1") {
      const parsed = DesignAutomationRecipeSchema.safeParse(snapshot.recipe);
      if (!parsed.success || !parsed.data.pillowPipeline) {
        diagnostics.push({ code: "rule_pillow_pipeline_not_enabled", severity: "manual", message: `固定规则“${rule.name}”V${rule.version}仅适用于显式审核的新抱枕配方；当前任务保留原流程，需要人工核验。` });
      } else if (snapshot.document.productType !== "shaped_pillow" || snapshot.document.spec.factoryStandardId !== parsed.data.pillowPipeline.factoryStandard || snapshot.model?.model !== parsed.data.pillowPipeline.requiredModel) {
        diagnostics.push({ code: "rule_pillow_pipeline_conflict", severity: "error", message: `固定规则“${rule.name}”V${rule.version}要求匹配工厂标准和固定 gpt-image-2.5 模型；当前任务不可执行。` });
      }
    } else if (rule.binding === "faithful_enhancement" && snapshot.assets.some(asset => asset.buyerOriginal) && snapshot.recipe.imagePolicy !== "faithful_enhancement") {
      diagnostics.push({ code: "rule_enhancement_conflict", severity: "error", message: `固定规则“${rule.name}”V${rule.version}要求保真美化，当前工艺配方未启用。请修订并审核底稿后重新派发。` });
    } else if (rule.binding === "pillow_factory" && (snapshot.document.productType !== "shaped_pillow" || snapshot.document.spec.factoryStandardId !== SHAPED_PILLOW_FACTORY_STANDARD.id)) {
      diagnostics.push({ code: "rule_factory_conflict", severity: "error", message: `固定规则“${rule.name}”V${rule.version}与工艺底稿的工厂标准不一致。请核对底稿版本后重新派发。` });
    }
  }
  return diagnostics;
}
