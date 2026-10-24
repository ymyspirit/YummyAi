import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { FulfillmentCommandQuerySchema, PrepareFulfillmentCommandSchema } from "@yummyai/contracts/order/fulfillment-command";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { parseRequestSchema } from "../request-schema.js";
import { OrderFulfillmentCommandService } from "./order-fulfillment-command.service.js";

@Controller("v1/order-centers/fulfillment-commands")
@RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead)
export class OrderFulfillmentCommandController {
  constructor(@Inject(OrderFulfillmentCommandService) private readonly commands: OrderFulfillmentCommandService) {}
  @Get()
  @Header("Cache-Control", "private, no-store")
  list(@Req() request: AuthenticatedRequest, @Query() query: unknown) { return this.commands.list(context(request), parseRequestSchema(FulfillmentCommandQuerySchema, query)); }
  @Get(":id")
  @Header("Cache-Control", "private, no-store")
  get(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Query() query: unknown) { empty(query); return this.commands.get(context(request), id(value)); }
  @Post()
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead)
  prepare(@Req() request: AuthenticatedRequest, @Body() body: unknown, @Query() query: unknown) { empty(query); return this.commands.prepare(context(request), parseRequestSchema(PrepareFulfillmentCommandSchema, body)); }
  @Post(":id/execute")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead)
  execute(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown, @Query() query: unknown) { empty(query); empty(body); return this.commands.execute(context(request), id(value)); }
  @Post(":id/cancel")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead)
  cancel(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown, @Query() query: unknown) { empty(query); empty(body); return this.commands.cancel(context(request), id(value)); }
  @Post(":id/acknowledge")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  acknowledge(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown, @Query() query: unknown) { empty(query); empty(body); return this.commands.acknowledge(context(request), id(value)); }
}
const empty = (value: unknown) => parseRequestSchema(z.object({}).strict(), value === undefined ? {} : value);
const id = (value: string) => parseRequestSchema(EntityIdSchema, value);
function context(request: AuthenticatedRequest) { if (!request.tenantContext) throw Error("Tenant context is required"); return request.tenantContext; }
