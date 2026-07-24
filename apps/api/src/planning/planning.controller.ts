import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import { CreateForecastRunInputSchema, EvaluateForecastInputSchema, OpenOperatingReconciliationInputSchema, OverrideForecastInputSchema, RebuildOperatingProjectionsInputSchema, RecordOperatingMetricSnapshotInputSchema, ResolveOperatingReconciliationInputSchema, UpsertOperatingMetricDefinitionInputSchema } from "@yummyai/contracts/planning";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { PlanningService } from "./planning.service.js";

@Controller("v1/planning")
export class PlanningController {
  constructor(@Inject(PlanningService) private readonly service: PlanningService) {}
  @Get("workspace") @RequiresPermission(Permission.OperationsRead) workspace(@Req() request: AuthenticatedRequest) { const context = requireContext(request); authorize(context, Permission.OperationsRead); return this.service.workspace(context); }
  @Post("forecasts") @RequiresPermission(Permission.ForecastWrite) createForecast(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.ForecastWrite); return this.service.createForecast(context, CreateForecastRunInputSchema.parse(body)); }
  @Post("forecasts/:runId/evaluations") @RequiresPermission(Permission.ForecastReview) evaluateForecast(@Req() request: AuthenticatedRequest, @Param("runId") runId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.ForecastReview); return this.service.evaluateForecast(context, z.uuidv7().parse(runId), EvaluateForecastInputSchema.parse(body)); }
  @Post("forecasts/:runId/overrides") @RequiresPermission(Permission.ForecastReview) overrideForecast(@Req() request: AuthenticatedRequest, @Param("runId") runId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.ForecastReview); return this.service.overrideForecast(context, z.uuidv7().parse(runId), OverrideForecastInputSchema.parse(body)); }
  @Post("metric-definitions") @RequiresPermission(Permission.OperationsWrite) upsertMetricDefinition(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OperationsWrite); return this.service.upsertMetricDefinition(context, UpsertOperatingMetricDefinitionInputSchema.parse(body)); }
  @Post("metric-snapshots") @RequiresPermission(Permission.OperationsWrite) recordMetricSnapshot(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OperationsWrite); return this.service.recordMetricSnapshot(context, RecordOperatingMetricSnapshotInputSchema.parse(body)); }
  @Post("reconciliations") @RequiresPermission(Permission.OperationsReconcile) openReconciliation(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OperationsReconcile); return this.service.openReconciliation(context, OpenOperatingReconciliationInputSchema.parse(body)); }
  @Post("reconciliations/:reconciliationId/resolve") @RequiresPermission(Permission.OperationsReconcile) resolveReconciliation(@Req() request: AuthenticatedRequest, @Param("reconciliationId") reconciliationId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OperationsReconcile); return this.service.resolveReconciliation(context, z.uuidv7().parse(reconciliationId), ResolveOperatingReconciliationInputSchema.parse(body)); }
  @Post("projections/rebuild") @RequiresPermission(Permission.OperationsReconcile) rebuildProjections(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OperationsReconcile); return this.service.rebuildProjections(context, RebuildOperatingProjectionsInputSchema.parse(body)); }
}
function requireContext(request: AuthenticatedRequest) { if (!request.tenantContext) throw new Error("Tenant context is required"); return request.tenantContext; }
