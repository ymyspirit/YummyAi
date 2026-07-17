import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import { CaptureDraftSchema } from "@yummyai/contracts";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { CaptureService } from "./capture.service.js";

@Controller("v1/captures")
export class CaptureController {
  constructor(@Inject(CaptureService) private readonly captures: CaptureService) {}

  @Post()
  @RequiresPermission(Permission.CaptureWrite)
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.CaptureWrite);
    return this.captures.createSnapshot(context, CaptureDraftSchema.parse(body));
  }

  @Get(":id")
  @RequiresPermission(Permission.CaptureRead)
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.CaptureRead);
    return this.captures.getSnapshot(context, id);
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
