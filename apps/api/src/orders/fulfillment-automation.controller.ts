import { Body, Controller, Get, Inject, Param, Patch, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import {
  CancelFulfillmentAutomationInputSchema, ReconcileFulfillmentAutomationInputSchema,
  ScheduleFulfillmentAutomationInputSchema, UpdateFulfillmentAutomationPolicyInputSchema,
} from "@yummyai/contracts";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { FulfillmentAutomationService } from "./fulfillment-automation.service.js";

@Controller("v1/fulfillment-automations")
export class FulfillmentAutomationController {
  constructor(@Inject(FulfillmentAutomationService) private readonly service: FulfillmentAutomationService) {}
  @Get() @RequiresPermission(Permission.OrderRead)
  list(@Req() request: AuthenticatedRequest) { const context = requireContext(request); authorize(context, Permission.OrderRead); return this.service.list(context); }
  @Get(":taskId") @RequiresPermission(Permission.OrderRead)
  get(@Req() request: AuthenticatedRequest, @Param("taskId") taskId: string) { const context = requireContext(request); authorize(context, Permission.OrderRead); return this.service.get(context, z.uuidv7().parse(taskId)); }
  @Post() @RequiresPermission(Permission.OrderWrite)
  schedule(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.service.schedule(context, ScheduleFulfillmentAutomationInputSchema.parse(body)); }
  @Post(":taskId/cancel") @RequiresPermission(Permission.OrderWrite)
  cancel(@Req() request: AuthenticatedRequest, @Param("taskId") taskId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.service.cancel(context, z.uuidv7().parse(taskId), CancelFulfillmentAutomationInputSchema.parse(body)); }
  @Post(":taskId/reconcile") @RequiresPermission(Permission.OrderWrite)
  reconcile(@Req() request: AuthenticatedRequest, @Param("taskId") taskId: string, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.service.reconcile(context, z.uuidv7().parse(taskId), ReconcileFulfillmentAutomationInputSchema.parse(body)); }
  @Patch("policy") @RequiresPermission(Permission.OrderWrite)
  policy(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const context = requireContext(request); authorize(context, Permission.OrderWrite); return this.service.updatePolicy(context, UpdateFulfillmentAutomationPolicyInputSchema.parse(body)); }
}
function requireContext(request: AuthenticatedRequest) { if (!request.tenantContext) throw new Error("Tenant context is required"); return request.tenantContext; }
