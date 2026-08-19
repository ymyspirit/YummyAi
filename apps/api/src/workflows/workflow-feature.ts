import { NotFoundException } from "@nestjs/common";

export function workflowCenterEnabled(
  tenantId: string,
  configuredTenantIds = process.env.WORKFLOW_CENTER_TENANT_IDS,
) {
  const configured = configuredTenantIds?.trim();
  if (!configured || configured === "*") return true;
  return configured.split(",").map((value) => value.trim()).filter(Boolean).includes(tenantId);
}

export function assertWorkflowCenterEnabled(tenantId: string) {
  if (!workflowCenterEnabled(tenantId)) {
    throw new NotFoundException("Workflow center is not enabled for this tenant");
  }
}
