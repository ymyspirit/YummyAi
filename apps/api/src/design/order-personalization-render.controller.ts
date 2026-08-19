import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import { CreateOrderPersonalizationRenderTaskInputSchema } from "@yummyai/contracts";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { OrderPersonalizationRenderService } from "./order-personalization-render.service.js";

@Controller("v1/pod/order-personalization-render-tasks")
export class OrderPersonalizationRenderController {
  constructor(@Inject(OrderPersonalizationRenderService) private readonly renders: OrderPersonalizationRenderService) {}

  @Get()
  @RequiresPermission(Permission.OrderRead, Permission.DesignRead)
  list(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.OrderRead);
    authorize(context, Permission.DesignRead);
    return this.renders.list(context);
  }

  @Get(":id")
  @RequiresPermission(Permission.OrderRead, Permission.DesignRead)
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.OrderRead);
    authorize(context, Permission.DesignRead);
    return this.renders.get(context, z.uuidv7().parse(id));
  }

  @Post()
  @RequiresPermission(Permission.OrderWrite, Permission.OrderPiiRead, Permission.DesignWrite)
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.OrderWrite);
    authorize(context, Permission.OrderPiiRead);
    authorize(context, Permission.DesignWrite);
    return this.renders.create(context, CreateOrderPersonalizationRenderTaskInputSchema.parse(body));
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
