import type { TenantContext } from "@yummyai/contracts";
import type { WorkflowExecutionSnapshot } from "@yummyai/contracts/workflow/execution";
import { AgentMethodAuthorityError, assertAgentMethodSelection, selectAgentMethod, type TenantTransaction } from "@yummyai/database";
import { assertMethodKnowledge } from "@yummyai/knowledge-core";
import { workflowHarness } from "./harness.js";
import { WorkflowExecutionError } from "./errors.js";

export async function assertWorkflowMethod(tx: TenantTransaction, context: TenantContext, snapshot: WorkflowExecutionSnapshot, options: { lock?: boolean; admission?: boolean } = {}) {
  const binding = workflowHarness(snapshot.capabilityKey);
  try {
    const method = await assertAgentMethodSelection(tx, binding.registry.describeSkill(binding.skill), snapshot.methodSelection, options);
    await assertMethodKnowledge(tx, context, method.definition, { lock: options.lock });
    return method.selection;
  } catch (error) {
    if (error instanceof AgentMethodAuthorityError) throw new WorkflowExecutionError("WORKFLOW_METHOD_UNAVAILABLE");
    throw error;
  }
}
export async function selectWorkflowMethod(tx: TenantTransaction, context: TenantContext, snapshot: WorkflowExecutionSnapshot) {
  const binding = workflowHarness(snapshot.capabilityKey);
  try {
    const selected = await selectAgentMethod(tx, binding.registry.describeSkill(binding.skill));
    await assertWorkflowMethod(tx, context, { ...snapshot, methodSelection: selected.selection }, { lock: true, admission: true });
    return selected.selection;
  } catch (error) {
    if (error instanceof AgentMethodAuthorityError) throw new WorkflowExecutionError("WORKFLOW_METHOD_UNAVAILABLE");
    throw error;
  }
}
