"use client";
import { useCallback } from "react";
import { WorkflowResponsibilityViewSchema } from "@yummyai/contracts/workflow/responsibility";
import {
  ResponsibilityPanel,
  type ResponsibilitySaveInput,
} from "../responsibility/responsibility-panel";
import { readWorkflow } from "./workflow-operator-client";
import { saveWorkflowResponsibility, type WorkflowActionState } from "./workflow-actions";
export function WorkflowResponsibilityPanel({
  runId,
  nodeId,
  revision,
  disabled,
  onResult,
}: {
  runId: string;
  nodeId: string;
  revision: number;
  disabled: boolean;
  onResult(result: WorkflowActionState<{ revision: number }>): void;
}) {
  const read = useCallback(
    (search: string, signal: AbortSignal) =>
      readWorkflow(
        runId +
          "/nodes/" +
          encodeURIComponent(nodeId) +
          "/responsibility" +
          (search ? "?q=" + encodeURIComponent(search) : ""),
        WorkflowResponsibilityViewSchema,
        signal,
      ),
    [runId, nodeId],
  );
  const save = useCallback(
    (input: ResponsibilitySaveInput) =>
      saveWorkflowResponsibility(runId, nodeId, {
        expectedRevision: input.expectedRevision,
        assignedUserId: input.assignedUserId,
        dueAt: input.dueAt,
        escalationUserId: input.escalationUserId,
        escalationDelayMinutes: input.escalationDelayMinutes,
        reason: input.reason,
      }),
    [runId, nodeId],
  );
  return (
    <ResponsibilityPanel
      key={runId + ":" + nodeId}
      recordKey={runId + ":" + nodeId}
      revision={revision}
      disabled={disabled}
      read={read}
      save={save}
      onResult={onResult}
    />
  );
}
