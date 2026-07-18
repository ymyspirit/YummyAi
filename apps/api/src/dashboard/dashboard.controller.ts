import { Controller, Get, Inject, Query, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { DashboardService } from "./dashboard.service.js";

@Controller("v1/dashboard")
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly service: DashboardService) {}

  @Get()
  @RequiresPermission(Permission.DashboardRead)
  metrics(@Req() request: AuthenticatedRequest, @Query() query: { from?: string; to?: string; timezone?: string }) {
    const context = requireContext(request); authorize(context, Permission.DashboardRead);
    const today = new Date().toISOString().slice(0, 10);
    return this.service.getMetrics(context, { from: query.from ?? today, to: query.to ?? today, timezone: query.timezone ?? "UTC" });
  }
}

function requireContext(request: AuthenticatedRequest) { if (!request.tenantContext) throw new Error("Tenant context is required"); return request.tenantContext; }
