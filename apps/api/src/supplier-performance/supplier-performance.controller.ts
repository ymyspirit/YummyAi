import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import {
  CalculateSupplierScorecardInputSchema,
  UpsertSupplierKpiDefinitionInputSchema,
} from "@yummyai/contracts/supplier-performance";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { SupplierPerformanceService } from "./supplier-performance.service.js";

@Controller("v1/supplier-performance")
export class SupplierPerformanceController {
  constructor(
    @Inject(SupplierPerformanceService) private readonly service: SupplierPerformanceService,
  ) {}

  @Get("workspace")
  @RequiresPermission(Permission.SupplierPerformanceRead)
  workspace(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.SupplierPerformanceRead);
    return this.service.workspace(context);
  }

  @Get("scorecards/:runId")
  @RequiresPermission(Permission.SupplierPerformanceRead)
  scorecard(@Req() request: AuthenticatedRequest, @Param("runId") runId: string) {
    const context = requireContext(request);
    authorize(context, Permission.SupplierPerformanceRead);
    return this.service.getScorecard(context, z.uuidv7().parse(runId));
  }

  @Post("definitions")
  @RequiresPermission(Permission.SupplierPerformanceReview)
  upsertDefinition(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.SupplierPerformanceReview);
    return this.service.upsertDefinition(
      context,
      UpsertSupplierKpiDefinitionInputSchema.parse(body),
    );
  }

  @Post("scorecards")
  @RequiresPermission(Permission.SupplierPerformanceReview)
  calculate(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.SupplierPerformanceReview);
    return this.service.calculateScorecard(
      context,
      CalculateSupplierScorecardInputSchema.parse(body),
    );
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
