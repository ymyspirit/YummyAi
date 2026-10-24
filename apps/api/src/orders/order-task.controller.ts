import { Body, Controller, Get, Header, Inject, Param, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { Permission } from "@yummyai/authz";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { OrderTaskService } from "./order-task.service.js";
@Controller("v1/order-centers/lines/:id/task")
export class OrderTaskController {
  constructor(@Inject(OrderTaskService) private readonly service: OrderTaskService) {}
  @Get() @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead)
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return this.service.get(context(request), z.uuidv7().parse(id)); }
  @Post("prepare-delivery") @Header("Cache-Control", "private, no-store") @RequiresPermission(Permission.OrderWrite, Permission.DesignRead, Permission.AssetRead)
  prepare(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.service.prepareDelivery(context(request), z.uuidv7().parse(id), body); }
}
function context(request: AuthenticatedRequest) { if (!request.tenantContext) throw new Error("Tenant context required"); return request.tenantContext; }
