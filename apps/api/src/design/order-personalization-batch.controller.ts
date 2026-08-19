import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import { CreateOrderPersonalizationBatchInputSchema } from "@yummyai/contracts";
import { z } from "zod";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { OrderPersonalizationBatchService } from "./order-personalization-batch.service.js";

@Controller("v1/pod/order-personalization-batches")
export class OrderPersonalizationBatchController {
  constructor(@Inject(OrderPersonalizationBatchService) private readonly batches: OrderPersonalizationBatchService) {}

  @Get()
  @RequiresPermission(Permission.OrderRead, Permission.DesignRead)
  list(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.OrderRead);
    authorize(context, Permission.DesignRead);
    return this.batches.list(context);
  }

  @Get("options")
  @RequiresPermission(Permission.OrderRead, Permission.DesignRead)
  options(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.OrderRead);
    authorize(context, Permission.DesignRead);
    return this.batches.options(context);
  }

  @Get(":id")
  @RequiresPermission(Permission.OrderRead, Permission.DesignRead)
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const context = requireContext(request);
    authorize(context, Permission.OrderRead);
    authorize(context, Permission.DesignRead);
    return this.batches.get(context, z.uuidv7().parse(id));
  }

  @Post()
  @RequiresPermission(Permission.OrderWrite, Permission.OrderPiiRead, Permission.DesignWrite)
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.OrderWrite);
    authorize(context, Permission.OrderPiiRead);
    authorize(context, Permission.DesignWrite);
    return this.batches.create(context, CreateOrderPersonalizationBatchInputSchema.parse(body));
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
