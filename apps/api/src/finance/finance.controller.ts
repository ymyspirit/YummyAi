import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import {
  CalculateFinanceProfitInputSchema,
  RecordFinanceFxRateInputSchema,
  RecordFinanceStatementInputSchema,
  UpsertFinanceProfitMetricInputSchema,
} from "@yummyai/contracts/finance";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { FinanceService } from "./finance.service.js";

@Controller("v1/finance")
export class FinanceController {
  constructor(@Inject(FinanceService) private readonly service: FinanceService) {}

  @Get("workspace")
  @RequiresPermission(Permission.FinanceRead)
  workspace(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.FinanceRead);
    return this.service.workspace(context);
  }

  @Get("statements/:statementId")
  @RequiresPermission(Permission.FinanceRead)
  statement(@Req() request: AuthenticatedRequest, @Param("statementId") statementId: string) {
    const context = requireContext(request);
    authorize(context, Permission.FinanceRead);
    return this.service.getStatement(context, z.uuidv7().parse(statementId));
  }

  @Get("profit-runs/:runId")
  @RequiresPermission(Permission.FinanceRead)
  profitRun(@Req() request: AuthenticatedRequest, @Param("runId") runId: string) {
    const context = requireContext(request);
    authorize(context, Permission.FinanceRead);
    return this.service.getProfitRun(context, z.uuidv7().parse(runId));
  }

  @Post("statements")
  @RequiresPermission(Permission.FinanceWrite)
  recordStatement(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.FinanceWrite);
    return this.service.recordStatement(context, RecordFinanceStatementInputSchema.parse(body));
  }

  @Post("fx-rates")
  @RequiresPermission(Permission.FinanceWrite)
  recordFxRate(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.FinanceWrite);
    return this.service.recordFxRate(context, RecordFinanceFxRateInputSchema.parse(body));
  }

  @Post("profit-metrics")
  @RequiresPermission(Permission.FinanceReview)
  upsertProfitMetric(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.FinanceReview);
    return this.service.upsertProfitMetric(
      context,
      UpsertFinanceProfitMetricInputSchema.parse(body),
    );
  }

  @Post("profit-runs")
  @RequiresPermission(Permission.FinanceReview)
  calculateProfit(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.FinanceReview);
    return this.service.calculateProfit(context, CalculateFinanceProfitInputSchema.parse(body));
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
