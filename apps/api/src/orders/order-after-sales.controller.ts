import { Body, Controller, Get, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import {
  AddResponsibilityEvidenceInputSchema, CreateAfterSalesCaseInputSchema, CreateReturnShipmentInputSchema,
  DecideAfterSalesCaseInputSchema, LinkReplacementOrderInputSchema, RecordCustomerContactInputSchema,
  RecordReturnTrackingEventInputSchema,
} from "@yummyai/contracts";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { OrderAfterSalesService } from "./order-after-sales.service.js";

@Controller("v1/after-sales-cases")
export class OrderAfterSalesController {
  constructor(@Inject(OrderAfterSalesService) private readonly afterSales: OrderAfterSalesService) {}

  @Get()
  @RequiresPermission(Permission.OrderRead)
  list(@Req() request: AuthenticatedRequest, @Query("orderId") orderId: unknown) {
    const context = requireContext(request); authorize(context, Permission.OrderRead);
    return this.afterSales.list(context, orderId === undefined ? undefined : z.uuidv7().parse(orderId));
  }

  @Get(":caseId")
  @RequiresPermission(Permission.OrderRead)
  get(@Req() request: AuthenticatedRequest, @Param("caseId") caseId: string) {
    const context = requireContext(request); authorize(context, Permission.OrderRead);
    return this.afterSales.get(context, z.uuidv7().parse(caseId));
  }

  @Post(":caseId/contacts")
  @RequiresPermission(Permission.OrderWrite)
  contact(@Req() request: AuthenticatedRequest, @Param("caseId") caseId: string, @Body() body: unknown) {
    const context = requireContext(request); authorize(context, Permission.OrderWrite);
    return this.afterSales.recordContact(context, z.uuidv7().parse(caseId), RecordCustomerContactInputSchema.parse(body));
  }

  @Post(":caseId/decisions")
  @RequiresPermission(Permission.OrderWrite)
  decide(@Req() request: AuthenticatedRequest, @Param("caseId") caseId: string, @Body() body: unknown) {
    const context = requireContext(request); authorize(context, Permission.OrderWrite);
    return this.afterSales.decide(context, z.uuidv7().parse(caseId), DecideAfterSalesCaseInputSchema.parse(body));
  }

  @Post(":caseId/return-shipments")
  @RequiresPermission(Permission.OrderWrite)
  createReturn(@Req() request: AuthenticatedRequest, @Param("caseId") caseId: string, @Body() body: unknown) {
    const context = requireContext(request); authorize(context, Permission.OrderWrite);
    return this.afterSales.createReturnShipment(context, z.uuidv7().parse(caseId), CreateReturnShipmentInputSchema.parse(body));
  }

  @Post(":caseId/return-shipments/:returnShipmentId/events")
  @RequiresPermission(Permission.OrderWrite)
  returnEvent(@Req() request: AuthenticatedRequest, @Param("caseId") caseId: string, @Param("returnShipmentId") returnShipmentId: string, @Body() body: unknown) {
    const context = requireContext(request); authorize(context, Permission.OrderWrite);
    return this.afterSales.recordReturnTracking(context, z.uuidv7().parse(caseId), z.uuidv7().parse(returnShipmentId), RecordReturnTrackingEventInputSchema.parse(body));
  }

  @Post(":caseId/replacements")
  @RequiresPermission(Permission.OrderWrite)
  replacement(@Req() request: AuthenticatedRequest, @Param("caseId") caseId: string, @Body() body: unknown) {
    const context = requireContext(request); authorize(context, Permission.OrderWrite);
    return this.afterSales.linkReplacement(context, z.uuidv7().parse(caseId), LinkReplacementOrderInputSchema.parse(body));
  }

  @Post(":caseId/responsibility-evidence")
  @RequiresPermission(Permission.OrderWrite)
  evidence(@Req() request: AuthenticatedRequest, @Param("caseId") caseId: string, @Body() body: unknown) {
    const context = requireContext(request); authorize(context, Permission.OrderWrite);
    return this.afterSales.addResponsibilityEvidence(context, z.uuidv7().parse(caseId), AddResponsibilityEvidenceInputSchema.parse(body));
  }
}

@Controller("v1/orders")
export class OrderAfterSalesCommandController {
  constructor(@Inject(OrderAfterSalesService) private readonly afterSales: OrderAfterSalesService) {}

  @Post(":id/after-sales-cases")
  @RequiresPermission(Permission.OrderWrite)
  create(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request); authorize(context, Permission.OrderWrite);
    return this.afterSales.create(context, z.uuidv7().parse(id), CreateAfterSalesCaseInputSchema.parse(body));
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
