import { Body, Controller, Get, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { Permission } from "@yummyai/authz";
import { OrderLineResponsibilityInputSchema } from "@yummyai/contracts/order/responsibility";
import { OrderTaskInboxQuerySchema } from "@yummyai/contracts/order/task-inbox";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { OrderResponsibilityService } from "./order-responsibility.service.js";
const querySchema = z.object({ q: z.string().trim().max(100).default("") }).strict();
@Controller("v1/order-centers")
export class OrderResponsibilityController {
  constructor(
    @Inject(OrderResponsibilityService) private readonly responsibility: OrderResponsibilityService,
  ) {}
  @Get("tasks")
  @RequiresPermission(Permission.OrderRead)
  list(@Req() request: AuthenticatedRequest, @Query() raw: unknown) {
    return this.responsibility.list(request.tenantContext!, OrderTaskInboxQuerySchema.parse(raw));
  }
  @Get("lines/:id/responsibility")
  @RequiresPermission(Permission.OrderRead)
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query() raw: unknown) {
    return this.responsibility.get(
      request.tenantContext!,
      z.uuidv7().parse(id),
      querySchema.parse(raw).q,
    );
  }
  @Post("lines/:id/responsibility")
  @RequiresPermission(Permission.OrderAssign)
  update(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() raw: unknown) {
    return this.responsibility.update(
      request.tenantContext!,
      z.uuidv7().parse(id),
      OrderLineResponsibilityInputSchema.parse(raw),
    );
  }
}
