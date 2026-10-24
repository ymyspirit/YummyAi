import { Body, Controller, Get, Header, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { CreateProductionOrderInputSchema } from "@yummyai/contracts/order/production";
import { NativeProductionReceiptSchema } from "@yummyai/contracts/order/native-production";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { NativeProductionService } from "./native-production.service.js";
import { OrderProductionService } from "./order-production.service.js";
import { parseRequestSchema } from "../request-schema.js";

@Controller("v1/order-centers/native")
export class NativeProductionController {
  constructor(@Inject(NativeProductionService) private readonly native: NativeProductionService,
    @Inject(OrderProductionService) private readonly production: OrderProductionService) {}
  @Get()
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead)
  workspace(@Req() request: AuthenticatedRequest, @Query() query: unknown) { return this.native.workspace(context(request), query); }
  @Get("lines/:id")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead)
  detail(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown) { return this.native.detail(context(request), parseRequestSchema(z.uuidv7(), id), query); }
  @Get("lines/:id/factories")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead)
  factories(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown) { return this.native.factoryChoices(context(request), parseRequestSchema(z.uuidv7(), id), query); }
  @Post("orders/:id/production")
  @RequiresPermission(Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead)
  async create(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() raw: unknown, @Query() query: unknown) {
    parseRequestSchema(z.object({}).strict(), query); const orderId = parseRequestSchema(z.uuidv7(), id), input = parseRequestSchema(CreateProductionOrderInputSchema, raw);
    const saved = await this.production.create(context(request), orderId, input);
    return NativeProductionReceiptSchema.parse({ productionOrderId: saved.productionOrder.id, orderId: saved.productionOrder.orderId, lineId: saved.productionOrder.orderLineId });
  }
}
function context(request: AuthenticatedRequest) { if (!request.tenantContext) throw Error("Tenant context is required"); return request.tenantContext; }
