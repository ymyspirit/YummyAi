import { NotFoundException } from "@nestjs/common";

import { workflowCenterEnabled } from "@yummyai/workflow-core";
export { workflowCenterEnabled } from "@yummyai/workflow-core";

export function assertWorkflowCenterEnabled(tenantId: string) {
  if (!workflowCenterEnabled(tenantId)) {
    throw new NotFoundException("Workflow center is not enabled for this tenant");
  }
}
