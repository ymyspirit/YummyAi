import { HarnessRegistry, HarnessContractError } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { z } from "zod";
import { PodExecutableToolKeySchema, CreatePodArtworkTaskInputSchema } from "@yummyai/contracts";
import { CatalogPreparedOperationSchema } from "@yummyai/contracts/catalog/operation";
import { PodPreparedOperationSchema } from "@yummyai/contracts/pod/operation";
import { HarnessArtifactOutcomeSchema, type HarnessExecutionContract } from "@yummyai/contracts/harness";
import type { WorkflowPortDataType } from "@yummyai/contracts/workflow";
import { WorkflowExecutionError } from "./errors.js";
import { podToolLabel } from "@yummyai/contracts/pod/labels";

const version = "workflow-method-2026-10-16-v1", policyVersion = "workflow-owner-access-2026-10-16-v1";
const base = [Permission.WorkflowRead, Permission.WorkflowRun, Permission.ProductRead];
type Binding = { key: string; label: string; kind: "profile" | "package" | "pod"; inputTypes: WorkflowPortDataType[]; outputTypes: WorkflowPortDataType[]; requiredPermission: string; rightsPolicy: "authorized_only" | "reference_analysis_only" };
const bindings: Binding[] = [
  { key: "yummyai.custom_product.generate_provisional_facts", label: "整理待核实商品事实", kind: "profile", inputTypes: ["research_snapshot"], outputTypes: ["product_facts"], requiredPermission: Permission.ProductWrite, rightsPolicy: "reference_analysis_only" },
  { key: "yummyai.custom_product.export_package", label: "导出固定商品包", kind: "package", inputTypes: ["product_facts", "design_version"], outputTypes: ["product_package"], requiredPermission: Permission.ProductWrite, rightsPolicy: "authorized_only" },
  ...PodExecutableToolKeySchema.options.map(toolKey => ({ key: `pod.${toolKey}`, label: `工作流 · ${podToolLabel(toolKey)}`, kind: "pod" as const, inputTypes: ["image" as const], outputTypes: ["design_version" as const], requiredPermission: Permission.DesignWrite, rightsPolicy: toolKey === "rights_risk_scan" ? "reference_analysis_only" as const : "authorized_only" as const })),
];
const bundle = new Map<string, { registry: HarnessRegistry; skill: { key: string; version: string }; toolKey: string; binding: Binding }>();
for (const binding of bindings) {
  const pod = binding.kind === "pod", toolKey = binding.key, skill = { key: `workflow.${toolKey}`, version };
  const requiredPermissions = [...base, ...(pod ? [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead] : [Permission.ProductWrite, ...(binding.kind === "profile" ? [Permission.ResearchRead] : [Permission.AssetRead])])].sort();
  const inputSchema = pod
    ? PodPreparedOperationSchema.extend({ input: CreatePodArtworkTaskInputSchema.safeExtend({ toolKey: z.literal(PodExecutableToolKeySchema.parse(toolKey.slice(4))) }) })
    : CatalogPreparedOperationSchema.extend({ operation: z.literal(binding.kind === "profile" ? "profile" : "package") });
  const artifact = HarnessArtifactOutcomeSchema.extend({ artifactType: z.literal(pod ? "design_version" : binding.kind === "profile" ? "product_facts" : "product_package") });
  const registry = new HarnessRegistry("workflow_node", [{ descriptor: {
    key: toolKey, version, label: binding.label, owner: pod ? "pod_owner" : "catalog_owner", effect: pod ? "delegated_job" : "internal_write",
    inputSchemaKey: pod ? "pod.prepared-operation" : "catalog.prepared-operation", outputSchemaKey: pod ? "pod.delegated-outcome" : "catalog.artifact-outcome",
    permissionPolicyVersion: policyVersion, requiredPermissions, resourcePolicy: pod ? "pod.current-pinned-operation" : "catalog.current-pinned-operation",
    dataDomains: ["research", "authorized_asset", "business"],
    timeout: { mode: "fenced_lease", milliseconds: 300_000 }, maxInputBytes: 1024 * 1024, maxOutputBytes: 4096,
    recovery: pod ? "original_child_task" : "owner_receipt", approval: "owning_business_flow",
  }, inputSchema, outputSchema: pod ? z.union([artifact, z.object({ delegatedTaskId: z.uuidv7(), state: z.literal("waiting") }).strict()]) : artifact }], [{
    ...skill, label: binding.label, instructions: "依据已固定的输入调用所属业务服务，复用原回执或子任务，验证产物后交接；不得替代业务审核、生产批准或外部对账。",
    steps: ["authorize_current_member", "validate_pinned_owner_input", "execute_or_reuse_owner_operation", "validate_owned_receipt", "handoff_without_approval"], tools: [{ key: toolKey, version }],
  }]);
  bundle.set(toolKey, { registry, skill, toolKey, binding });
}
export function workflowHarness(capability: string) {
  const value = bundle.get(capability);
  if (!value) throw new WorkflowExecutionError("WORKFLOW_CAPABILITY_UNSUPPORTED");
  return value;
}
export function assertWorkflowHarness(capability: string, contract: unknown, input: unknown) {
  const value = workflowHarness(capability);
  try { value.registry.checkInput(contract, value.skill, value.toolKey, input); }
  catch (error) {
    if (error instanceof HarnessContractError) throw new WorkflowExecutionError(error.code === "harness_contract_missing" ? "WORKFLOW_CONTRACT_MISSING" : "WORKFLOW_CONTRACT_CHANGED");
    throw error;
  }
  return value;
}
export function workflowHarnessCapabilities(): Array<Binding & { executionContract: HarnessExecutionContract }> {
  return [...bundle.values()].map(value => ({ ...value.binding, executionContract: value.registry.pin(value.skill) }));
}
export function registeredWorkflowMethods() {
  return [...bundle.values()].map(value => value.registry.describeSkill(value.skill));
}
