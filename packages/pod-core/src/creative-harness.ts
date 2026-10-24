import { HarnessRegistry } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { CreativeExecutionCompletionSchema, CreativeExecutionKindSchema, type CreativeExecutionKind } from "@yummyai/contracts/harness";
import { assertAgentMethodSelection, selectAgentMethod, type TenantTransaction } from "@yummyai/database";
import { assertMethodKnowledge } from "@yummyai/knowledge-core";
import { z } from "zod";

export const CreativeOriginalInputSchema = z.object({
  kind: CreativeExecutionKindSchema, ownerId: z.uuidv7(), stepKey: z.string().min(1).max(160),
  sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const version = "creative-owner-2026-10-19-v1";
type Effect = "external_request" | "internal_write";
const variants: Array<{ kind: CreativeExecutionKind; effect: Effect; label: string }> = [
  { kind: "creative_candidate", effect: "external_request", label: "批量创意候选" },
  { kind: "creative_adaptation", effect: "external_request", label: "原创意扩图适配" },
  { kind: "creative_adaptation", effect: "internal_write", label: "原创意确定性适配" },
  { kind: "template_compile", effect: "internal_write", label: "受控模板编译" },
  { kind: "mockup_render", effect: "internal_write", label: "原图稿套图" },
  { kind: "studio_generation", effect: "external_request", label: "个人创作生成" },
];
const bundles = variants.map(variant => {
  const key = `creative.${variant.kind}.${variant.effect}`, skill = { key, version };
  const required = [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead,
    ...(variant.kind === "studio_generation" ? [Permission.AssetWrite] : []),
    ...(variant.kind === "mockup_render" ? [Permission.ProductRead] : [])].sort();
  const localTool: ConstructorParameters<typeof HarnessRegistry>[1][number] = { descriptor: {
    key, version, label: variant.label, owner: "creative_owner", effect: variant.effect,
    inputSchemaKey: "creative.original-owner-v1", outputSchemaKey: "creative.completion-v1",
    permissionPolicyVersion: "creative-current-owner-v1", requiredPermissions: required,
    resourcePolicy: "creative.original-owner-and-pinned-sources", dataDomains: ["authorized_asset", "business", "knowledge", "research"],
    timeout: { mode: "fenced_lease", milliseconds: 300_000 }, maxInputBytes: 1024 * 1024, maxOutputBytes: 1024 * 1024,
    recovery: "response_or_reconcile", approval: "owning_business_flow",
  }, inputSchema: CreativeOriginalInputSchema.safeExtend({ kind: z.literal(variant.kind) }), outputSchema: CreativeExecutionCompletionSchema };
  const childKey = "creative.creative_adaptation.external_request";
  const tools = variant.kind === "creative_adaptation" && variant.effect === "internal_write"
    ? [localTool, { ...localTool, descriptor: { ...localTool.descriptor, key: childKey, label: "原创意扩图适配", effect: "external_request" as const } }]
    : [localTool];
  const registry = new HarnessRegistry("creative_owner", tools, [{
    ...skill, label: variant.label,
    instructions: "仅执行原拥有者固定的输入与文件版本，复核原权限上限和当前成员/来源，复用原提交、预算、响应与产物；输出保持待审核，不改写原权属、订单事实或生产批准。",
    steps: ["authorize_original_and_current_scope", "validate_original_owner_sources", "submit_or_restore_original_response", "verify_immutable_artifacts", "handoff_original_business_owner"],
    tools: tools.map(tool => ({ key: tool.descriptor.key, version })),
  }]);
  return { ...variant, registry, skill, key, requiredPermissions: required };
});

export function creativeHarness(kind: CreativeExecutionKind, effect: Effect) {
  const bundle = bundles.find(value => value.kind === kind && value.effect === effect);
  if (!bundle) throw new Error("CREATIVE_EXECUTOR_UNSUPPORTED");
  return bundle;
}
export function registeredCreativeMethods() { return bundles.map(bundle => bundle.registry.describeSkill(bundle.skill)); }
export async function selectCreativeMethod(tx: TenantTransaction, context: TenantContext, kind: CreativeExecutionKind, effect: Effect) {
  const bundle = creativeHarness(kind, effect), definition = bundle.registry.describeSkill(bundle.skill);
  const selected = await selectAgentMethod(tx, definition);
  await assertMethodKnowledge(tx, context, selected.definition, { lock: true });
  return { executionContract: definition.executionContract, methodSelection: selected.selection };
}
export async function assertCreativeMethod(tx: TenantTransaction, context: TenantContext, input: {
  kind: CreativeExecutionKind; effect: Effect; executionContract: ReturnType<typeof registeredCreativeMethods>[number]["executionContract"];
  methodSelection: Awaited<ReturnType<typeof selectCreativeMethod>>["methodSelection"];
}) {
  const bundle = creativeHarness(input.kind, input.effect);
  bundle.registry.assertCurrent(input.executionContract, bundle.skill);
  const selected = await assertAgentMethodSelection(tx, bundle.registry.describeSkill(bundle.skill), input.methodSelection, { lock: true });
  await assertMethodKnowledge(tx, context, selected.definition, { lock: true });
}
