import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import {
  AllocateFinancePaymentInputSchema, RecordFinanceBillInputSchema, RecordFinancePaymentInputSchema,
  ReleaseFinanceAllocationInputSchema,
} from "@yummyai/contracts/finance/payables";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { FinancePayablesService } from "./finance-payables.service.js";

@Controller("v1/finance/payables")
export class FinancePayablesController {
  constructor(@Inject(FinancePayablesService) private readonly service: FinancePayablesService) {}

  @Get("workspace")
  @RequiresPermission(Permission.FinanceRead)
  workspace(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.FinanceRead);
    parse(z.object({}).strict(), query);
    return this.service.workspace(context);
  }

  @Post("bills")
  @HttpCode(201)
  @RequiresPermission(Permission.FinanceWrite)
  recordBill(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.FinanceWrite);
    return this.service.recordBill(context, parse(RecordFinanceBillInputSchema, body));
  }

  @Post("payments")
  @HttpCode(201)
  @RequiresPermission(Permission.FinanceWrite)
  recordPayment(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.FinanceWrite);
    return this.service.recordPayment(context, parse(RecordFinancePaymentInputSchema, body));
  }

  @Post("allocations")
  @HttpCode(201)
  @RequiresPermission(Permission.FinanceReview)
  allocate(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.FinanceReview);
    return this.service.allocate(context, parse(AllocateFinancePaymentInputSchema, body));
  }

  @Post("allocations/:allocationId/releases")
  @HttpCode(201)
  @RequiresPermission(Permission.FinanceReview)
  release(@Req() request: AuthenticatedRequest, @Param("allocationId") rawId: string, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.FinanceReview);
    const allocationId = parse(EntityIdSchema, rawId).toLowerCase();
    return this.service.release(context, allocationId, parse(ReleaseFinanceAllocationInputSchema, body));
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException({ code: "finance_payables_input_invalid", message: "应付与付款填写或查询格式不正确" });
  return result.data;
}
