import { Body, Controller, Get, Header, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import {
  ProductionQuantityHistoryQuerySchema,
  ProductionQuantityReportInputSchema,
  ProductionQuantityReviewInputSchema,
} from "@yummyai/contracts/order/production-quantity";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { parseRequestSchema } from "../request-schema.js";
import { ProductionQuantityService } from "./production-quantity.service.js";

@Controller("v1/production/orders/:productionOrderId/quantity")
export class ProductionQuantityController {
  constructor(@Inject(ProductionQuantityService) private readonly quantities: ProductionQuantityService) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead)
  workspace(@Req() request: AuthenticatedRequest, @Param("productionOrderId") productionOrderId: string, @Query() query: unknown) {
    return this.quantities.workspace(context(request), parseRequestSchema(EntityIdSchema, productionOrderId),
      parseRequestSchema(ProductionQuantityHistoryQuerySchema, query));
  }

  @Post("reports")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderWrite)
  report(@Req() request: AuthenticatedRequest, @Param("productionOrderId") productionOrderId: string, @Body() body: unknown) {
    return this.quantities.recordReport(context(request), parseRequestSchema(EntityIdSchema, productionOrderId),
      parseRequestSchema(ProductionQuantityReportInputSchema, body));
  }

  @Post("reviews")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderWrite)
  review(@Req() request: AuthenticatedRequest, @Param("productionOrderId") productionOrderId: string, @Body() body: unknown) {
    return this.quantities.review(context(request), parseRequestSchema(EntityIdSchema, productionOrderId),
      parseRequestSchema(ProductionQuantityReviewInputSchema, body));
  }
}

function context(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
