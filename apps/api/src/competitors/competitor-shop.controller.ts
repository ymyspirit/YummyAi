import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import { CompetitorShopDraftSchema } from "@yummyai/contracts";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { CompetitorShopService } from "./competitor-shop.service.js";

@Controller("v1/competitor-shops")
export class CompetitorShopController {
  constructor(@Inject(CompetitorShopService) private readonly shops: CompetitorShopService) {}

  @Get()
  @RequiresPermission(Permission.ResearchRead)
  list(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.ResearchRead);
    return this.shops.list(context);
  }

  @Get(":id/snapshots")
  @RequiresPermission(Permission.ResearchRead)
  timeline(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.ResearchRead);
    return this.shops.timeline(context, id);
  }

  @Post("captures")
  @RequiresPermission(Permission.CaptureWrite)
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.CaptureWrite);
    return this.shops.createSnapshot(context, CompetitorShopDraftSchema.parse(body));
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
