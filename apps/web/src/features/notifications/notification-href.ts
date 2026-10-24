import { EntityIdSchema } from "@yummyai/contracts/common/ids";
/** Build local, supported destinations only. Notification metadata is not a URL. */
export function notificationHref(value: {
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}) {
  if (value.resourceType === "order_work_item" && EntityIdSchema.safeParse(value.resourceId).success)
    return `/business-tasks?object=order&target=${value.resourceId}`;
  if (["procurement_order", "after_sales_case", "order_exception"].includes(value.resourceType ?? "") && EntityIdSchema.safeParse(value.resourceId).success)
    return `/business-tasks?object=${value.resourceType}&target=${value.resourceId}`;
  if (value.resourceType !== "workflow_run" || !EntityIdSchema.safeParse(value.resourceId).success)
    return null;
  const task = EntityIdSchema.safeParse(value.metadata?.nodeRunId);
  return `/workflows/runs/${value.resourceId}${task.success ? `?task=${task.data}` : ""}`;
}
