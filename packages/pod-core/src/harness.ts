import { HarnessRegistry, HarnessContractError } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { CreatePodArtworkTaskInputSchema, PodExecutableToolKeySchema, type PodExecutableToolKey, type TenantContext } from "@yummyai/contracts";
import { PodMethodSnapshotSchema, type PodMethodSnapshot } from "@yummyai/contracts/harness/methods";
import { assertAgentMethodSelection, selectAgentMethod, AgentMethodAuthorityError, type TenantTransaction } from "@yummyai/database";
import { assertMethodKnowledge } from "@yummyai/knowledge-core";
import { z } from "zod";
import { PodOwnerError } from "./errors.js";
import { podToolLabel } from "@yummyai/contracts/pod/labels";
import { PodCompletionV1Schema } from "@yummyai/contracts/pod/completion";
import type { HarnessExecutionContract } from "@yummyai/contracts/harness";
import { legacyPodMethod, registeredLegacyPodMethods } from "./compat/legacy-methods.js";

const version = "pod-method-2026-10-18-v2";
const bundles = new Map(PodExecutableToolKeySchema.options.map(tool => {
  const toolKey = `pod.${tool}`, skill = { key: `pod.artwork.${tool}`, version };
  const registry = new HarnessRegistry("pod_artwork", [{ descriptor: {
    key: toolKey, version, label: podToolLabel(tool), owner: "pod_owner", effect: "external_request",
    inputSchemaKey: "pod.artwork-task-input", outputSchemaKey: "pod.completion-v1",
    permissionPolicyVersion: "pod-owner-access-2026-10-18-v1",
    requiredPermissions: [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead].sort(),
    resourcePolicy: "pod.current-pinned-operation", dataDomains: ["research", "authorized_asset", "business"],
    timeout: { mode: "fenced_lease", milliseconds: 300_000 }, maxInputBytes: 1024 * 1024, maxOutputBytes: 1024 * 1024,
    recovery: "original_child_task", approval: "owning_business_flow",
  }, inputSchema: CreatePodArtworkTaskInputSchema.safeExtend({ toolKey: z.literal(tool) }), outputSchema: PodCompletionV1Schema }], [{
    ...skill, label: `POD 处理 · ${podToolLabel(tool)}`,
    instructions: "使用已固定参数和有权素材执行原POD请求，复用原响应与费用证据；检查产物并交给所属业务审核，不得用方法说明修改制造参数、权利状态或生产批准。",
    steps: ["authorize_current_member", "validate_pinned_sources_and_parameters", "submit_or_restore_original_response", "validate_artifact_and_quality", "handoff_for_business_review"],
    tools: [{ key: toolKey, version }],
  }]);
  return [tool, { registry, skill, toolKey }] as const;
}));
export function podHarness(tool: PodExecutableToolKey) {
  return bundles.get(tool)!;
}
export function registeredPodMethods() {
  return [...bundles.values()].map(value => value.registry.describeSkill(value.skill));
}
export function supportedPodMethods() { return [...registeredPodMethods(), ...registeredLegacyPodMethods()]; }
export function assertPodMethodInput(tool: PodExecutableToolKey, snapshot: PodMethodSnapshot | null, input: unknown) {
  try {
  const binding = podHarness(tool);
  if (snapshot) definitionForContract(tool, snapshot.executionContract);
  // The legacy input schema is checked against the frozen schema before it is supported.
  // Validation does not replace the task's original method or publication selection.
  return binding.registry.checkInput(binding.registry.pin(binding.skill), binding.skill, binding.toolKey, input);
  } catch (error) { return methodFailure(error); }
}
function definitionForContract(tool: PodExecutableToolKey, contract: HarnessExecutionContract) {
  const binding = podHarness(tool);
  if (contract.skill.version === version) {
    binding.registry.assertCurrent(contract, binding.skill);
    return binding.registry.describeSkill(binding.skill);
  }
  return legacyPodMethod(tool, contract);
}
export async function assertPodMethod(tx: TenantTransaction, context: TenantContext, tool: PodExecutableToolKey, raw: unknown, options: { lock?: boolean; admission?: boolean } = {}) {
  try {
  const binding = podHarness(tool), snapshot = raw ? PodMethodSnapshotSchema.parse(raw) : null;
  const registered = snapshot ? definitionForContract(tool, snapshot.executionContract) : binding.registry.describeSkill(binding.skill);
  const selected = await assertAgentMethodSelection(tx, registered, snapshot?.methodSelection, options);
  await assertMethodKnowledge(tx, context, selected.definition, { lock: options.lock });
  return snapshot;
  } catch (error) { return methodFailure(error); }
}
export async function selectPodMethod(tx: TenantTransaction, context: TenantContext, tool: PodExecutableToolKey): Promise<PodMethodSnapshot> {
  try {
  const binding = podHarness(tool), selected = await selectAgentMethod(tx, binding.registry.describeSkill(binding.skill), { supported: registeredLegacyPodMethods() });
  const registered = supportedPodMethods().find(method => method.methodKey === binding.skill.key && method.executionContract.checksum === selected.selection.contractChecksum);
  if (!registered) throw new HarnessContractError("harness_contract_changed");
  const snapshot = PodMethodSnapshotSchema.parse({ schemaVersion: "pod-method-snapshot-v1", executionContract: registered.executionContract, methodSelection: selected.selection });
  await assertPodMethod(tx, context, tool, snapshot, { lock: true, admission: true });
  return snapshot;
  } catch (error) { return methodFailure(error); }
}
export function assertPodCompletionContract(tool: PodExecutableToolKey, snapshot: PodMethodSnapshot | null, raw: unknown) {
  const completion = PodCompletionV1Schema.parse(raw);
  const validation = snapshot ? snapshot.executionContract.skill.version === version ? "native_completion" : "legacy_owner_view" : "legacy_missing";
  if (completion.toolKey !== tool || completion.methodContractChecksum !== (snapshot?.executionContract.checksum ?? null) || completion.methodValidation !== validation)
    throw new HarnessContractError("harness_tool_output_invalid");
  if (snapshot) {
    definitionForContract(tool, snapshot.executionContract);
    if (validation === "native_completion") {
      const binding = podHarness(tool);
      binding.registry.checkOutput(snapshot.executionContract, binding.skill, binding.toolKey, completion);
    }
  }
  return completion;
}
function methodFailure(error: unknown): never {
  if (error instanceof AgentMethodAuthorityError || error instanceof HarnessContractError || error instanceof z.ZodError)
    throw new PodOwnerError("POD_METHOD_UNAVAILABLE", 409, "POD 方法版本、撤回状态或知识依据不可用，请核对原任务；不会自动补填旧快照或重新提交请求");
  throw error;
}
