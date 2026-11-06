import { Body, Controller, Get, Header, Inject, Param, Post, Req, UnauthorizedException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { OrderSyncScheduleService } from "./order-sync-schedule.service.js";

@Controller("v1/marketplace-accounts/:accountId/order-sync")
export class OrderSyncController {
  constructor(@Inject(OrderSyncScheduleService) private readonly sync: OrderSyncScheduleService) {}
  @Get()
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.StoreRead)
  view(@Req() request: AuthenticatedRequest, @Param("accountId") accountId: string) {
    if (!request.tenantContext) throw new UnauthorizedException();
    return this.sync.view(request.tenantContext, EntityIdSchema.parse(accountId));
  }
  @Post()
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.StoreManage, Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead)
  save(@Req() request: AuthenticatedRequest, @Param("accountId") accountId: string, @Body() body: unknown) {
    if (!request.tenantContext) throw new UnauthorizedException();
    return this.sync.save(request.tenantContext, EntityIdSchema.parse(accountId), body);
  }
}
