import { AssistKindSchema, CreateAssistSchema, AssistResultSchema, LegacyAssistResultSchema, type AssistKind } from "@yummyai/contracts/ai/assist";
import type { HarnessToolDescriptor } from "@yummyai/contracts/harness";
import { ASSIST_INSTRUCTIONS, ASSIST_BENCHMARK_INSTRUCTIONS } from "./assist.js";
import { ARTWORK_AUDIT_INSTRUCTIONS } from "./artwork-audit.js";
import { HarnessRegistry } from "./harness-registry.js";

const version = "assist-method-2026-10-27-v2";
const labels: Record<AssistKind, string> = {
  creative: "原创方向分析", order_review: "订单资料预审", artwork_preflight: "生产稿预检",
  template_config: "模板配置建议", sku_package: "SKU资料包建议", business_review: "经营依据分析",
  procurement_review: "采购依据分析", after_sales_review: "售后分析与回复草稿", knowledge_answer: "有引用的知识问答",
};
const domains: Record<AssistKind, HarnessToolDescriptor["dataDomains"]> = {
  creative: ["research", "authorized_asset", "knowledge"], order_review: ["order_private", "authorized_asset", "knowledge"],
  artwork_preflight: ["order_private", "authorized_asset", "knowledge"], template_config: ["authorized_asset", "knowledge"],
  sku_package: ["business", "authorized_asset", "knowledge"], business_review: ["business", "knowledge"],
  procurement_review: ["business", "knowledge"], after_sales_review: ["order_private", "business", "knowledge"],
  knowledge_answer: ["knowledge", "business"],
};
type Bundle = { registry: HarnessRegistry; skill: { key: string; version: string }; toolKey: string };
const cache = new Map<string, Bundle>();
/** Permissions come from the owning authz policy, never from task text or an imported Skill. */
export function assistHarness(kind: AssistKind, artworkAudit: boolean, permissions: readonly string[], permissionPolicyVersion: string, benchmark = false): Bundle {
  AssistKindSchema.parse(kind);
  if (benchmark && (kind !== "knowledge_answer" || artworkAudit)) throw new Error("assist_execution_version_unsupported");
  const requiredPermissions = [...new Set(permissions)].sort(), identity = JSON.stringify([kind, artworkAudit, requiredPermissions, permissionPolicyVersion, benchmark]);
  const cached = cache.get(identity); if (cached) return cached;
  const selectedVersion = benchmark ? "assist-benchmark-2026-10-21-v1" : version;
  const toolKey = `yummyai.assist.${kind}${benchmark ? ".benchmark" : ""}`, skill = { key: `${toolKey}${artworkAudit ? ".artwork_audit" : ".review"}`, version: selectedVersion };
  const inputSchema = CreateAssistSchema.options.find(option => option.shape.kind.value === kind)!;
  const registry = new HarnessRegistry("ai_assist", [{
    descriptor: {
      key: toolKey, version: selectedVersion, label: labels[kind], owner: "ai_assist", effect: "external_request",
      inputSchemaKey: `assist.${kind}.request`, outputSchemaKey: "assist.structured-result",
      permissionPolicyVersion, requiredPermissions, resourcePolicy: "assist.current-input-authority-v1", dataDomains: domains[kind],
      timeout: { mode: "abort_signal", milliseconds: 120_000 }, maxInputBytes: 1024 * 1024, maxOutputBytes: 8 * 1024 * 1024,
      recovery: "response_or_reconcile", approval: "owning_business_flow",
    }, inputSchema, outputSchema: benchmark ? AssistResultSchema : LegacyAssistResultSchema,
  }], [{
    ...skill, label: benchmark ? "固定数据集知识评测" : labels[kind], instructions: ASSIST_INSTRUCTIONS + (artworkAudit ? `\n${ARTWORK_AUDIT_INSTRUCTIONS}` : "") + (benchmark ? `\n${ASSIST_BENCHMARK_INSTRUCTIONS}` : ""),
    steps: ["authorize_current_member", "check_current_dependencies", "prepare_evidence", "checkpoint_response", "validate_citations", "handoff_to_business_owner"],
    tools: [{ key: toolKey, version: selectedVersion }],
  }]);
  const bundle = Object.freeze({ registry, skill: Object.freeze(skill), toolKey }); cache.set(identity, bundle); return bundle;
}
