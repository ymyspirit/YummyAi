import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { FactoryCapacityService } from "./factory-capacity.service.js";

@Controller("v1/sourcing")
export class FactoryCapacityController {
  constructor(@Inject(FactoryCapacityService) private readonly capacity: FactoryCapacityService) {}

  @Get("factories/:factoryId/capacity")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead)
  workspace(@Req() request: AuthenticatedRequest, @Param("factoryId") factoryId: string, @Query() query: unknown) {
    return this.capacity.workspace(context(request), EntityIdSchema.parse(factoryId), query);
  }

  @Post("factories/:factoryId/capacity-pools")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderWrite)
  createPool(@Req() request: AuthenticatedRequest, @Param("factoryId") factoryId: string, @Body() body: unknown) {
    return this.capacity.createPool(context(request), EntityIdSchema.parse(factoryId), body);
  }

  @Post("factories/:factoryId/capacity-pools/:poolId/revisions")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderWrite)
  revisePool(@Req() request: AuthenticatedRequest, @Param("factoryId") factoryId: string, @Param("poolId") poolId: string, @Body() body: unknown) {
    return this.capacity.revisePool(context(request), EntityIdSchema.parse(factoryId), EntityIdSchema.parse(poolId), body);
  }

  @Get("factories/:factoryId/capacity-pools/:poolId/history")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead)
  history(@Req() request: AuthenticatedRequest, @Param("factoryId") factoryId: string, @Param("poolId") poolId: string) {
    return this.capacity.history(context(request), EntityIdSchema.parse(factoryId), EntityIdSchema.parse(poolId));
  }

  @Post("factories/:factoryId/capacity-preview")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead)
  preview(@Req() request: AuthenticatedRequest, @Param("factoryId") factoryId: string, @Body() body: unknown) {
    return this.capacity.preview(context(request), EntityIdSchema.parse(factoryId), body);
  }

  @Post("factories/:factoryId/capacity/resolve-time")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead)
  resolveTime(@Req() request: AuthenticatedRequest, @Param("factoryId") factoryId: string, @Body() body: unknown) {
    return this.capacity.resolveTime(context(request), EntityIdSchema.parse(factoryId), body);
  }

  @Get("production-orders/:productionOrderId/capacity")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead)
  production(@Req() request: AuthenticatedRequest, @Param("productionOrderId") productionOrderId: string) {
    return this.capacity.production(context(request), EntityIdSchema.parse(productionOrderId));
  }
}

function context(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
