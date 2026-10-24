import { Body, Controller, Get, Header, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { AllocateQualityScrapInputSchema, QualityScrapHistoryQuerySchema } from "@yummyai/contracts/order/quality-scrap";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { parseRequestSchema } from "../request-schema.js";
import { QualityScrapService } from "./quality-scrap.service.js";

@Controller("v1/production/orders/:productionOrderId/quality-scrap")
export class QualityScrapController {
  constructor(@Inject(QualityScrapService) private readonly qualityScrap: QualityScrapService) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead)
  workspace(@Req() request: AuthenticatedRequest, @Param("productionOrderId") productionOrderId: string, @Query() query: unknown) {
    return this.qualityScrap.workspace(context(request), parseRequestSchema(EntityIdSchema, productionOrderId),
      parseRequestSchema(QualityScrapHistoryQuerySchema, query));
  }

  @Post("reviews")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderWrite)
  allocate(@Req() request: AuthenticatedRequest, @Param("productionOrderId") productionOrderId: string, @Body() body: unknown) {
    return this.qualityScrap.allocate(context(request), parseRequestSchema(EntityIdSchema, productionOrderId),
      parseRequestSchema(AllocateQualityScrapInputSchema, body));
  }
}

function context(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
