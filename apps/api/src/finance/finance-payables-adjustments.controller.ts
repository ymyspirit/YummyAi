import { BadRequestException, Body, Controller, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import {
  RecordFinanceBillAdjustmentInputSchema,
  RecordFinancePaymentAdjustmentInputSchema,
} from "@yummyai/contracts/finance/payables-adjustments";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { FinancePayablesAdjustmentsService } from "./finance-payables-adjustments.service.js";

@Controller("v1/finance/payables")
export class FinancePayablesAdjustmentsController {
  constructor(@Inject(FinancePayablesAdjustmentsService) private readonly service: FinancePayablesAdjustmentsService) {}

  @Post("bills/:billId/adjustments")
  @HttpCode(201)
  @RequiresPermission(Permission.FinanceReview)
  recordBillAdjustment(@Req() request: AuthenticatedRequest, @Param("billId") rawId: string, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.FinanceReview);
    return this.service.recordBillAdjustment(context, parse(EntityIdSchema, rawId).toLowerCase(),
      parse(RecordFinanceBillAdjustmentInputSchema, body));
  }

  @Post("payments/:paymentId/adjustments")
  @HttpCode(201)
  @RequiresPermission(Permission.FinanceReview)
  recordPaymentAdjustment(@Req() request: AuthenticatedRequest, @Param("paymentId") rawId: string, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.FinanceReview);
    return this.service.recordPaymentAdjustment(context, parse(EntityIdSchema, rawId).toLowerCase(),
      parse(RecordFinancePaymentAdjustmentInputSchema, body));
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException({ code: "finance_payables_input_invalid", message: "应付更正或付款退款填写格式不正确" });
  return result.data;
}
