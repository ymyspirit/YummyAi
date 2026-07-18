import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import { AnalysisRequestSchema } from "@yummyai/contracts";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { AnalysisService } from "./analysis.service.js";

@Controller("v1/ai/analyses")
export class AnalysisController {
  constructor(@Inject(AnalysisService) private readonly analyses: AnalysisService) {}

  @Post()
  @RequiresPermission(Permission.ResearchRead)
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.ResearchRead);
    return this.analyses.create(context, AnalysisRequestSchema.parse(body));
  }

  @Get(":reportSeriesId")
  @RequiresPermission(Permission.ResearchRead)
  latest(@Req() request: AuthenticatedRequest, @Param("reportSeriesId") reportSeriesId: string) {
    const context = requireContext(request);
    authorize(context, Permission.ResearchRead);
    return this.analyses.latest(context, z.uuidv7().parse(reportSeriesId));
  }

  @Get(":reportSeriesId/versions")
  @RequiresPermission(Permission.ResearchRead)
  versions(@Req() request: AuthenticatedRequest, @Param("reportSeriesId") reportSeriesId: string) {
    const context = requireContext(request);
    authorize(context, Permission.ResearchRead);
    return this.analyses.versions(context, z.uuidv7().parse(reportSeriesId));
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
