import { Controller, Get, Inject, Param, Patch, Query, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import { NotificationInboxQuerySchema } from "@yummyai/contracts/operations/notification";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { NotificationService } from "./notification.service.js";

@Controller("v1/notifications")
export class NotificationController {
  constructor(@Inject(NotificationService) private readonly service: NotificationService) {}
  @Get("inbox")
  @RequiresPermission(Permission.NotificationRead)
  inbox(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.NotificationRead);
    return this.service.inbox(context, NotificationInboxQuerySchema.parse(query));
  }
  @Get()
  @RequiresPermission(Permission.NotificationRead)
  list(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.NotificationRead);
    return this.service.list(
      context,
      NotificationInboxQuerySchema.omit({ after: true }).parse(query),
    );
  }
  @Patch("read-all")
  @RequiresPermission(Permission.NotificationRead)
  markAll(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.NotificationRead);
    return this.service.markAllRead(context).then((count) => ({ count }));
  }
  @Patch(":id/read")
  @RequiresPermission(Permission.NotificationRead)
  markOne(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.NotificationRead);
    return this.service.markRead(context, id);
  }
}
function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
