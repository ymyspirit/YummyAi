import { Body, Controller, Get, Header, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { PrepareProductionCommandSchema, ProductionCommandQuerySchema } from "@yummyai/contracts/order/production-command";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { parseRequestSchema } from "../request-schema.js";
import { ProductionCommandService } from "./production-command.service.js";

@Controller("v1/order-centers/production-commands")
@RequiresPermission(Permission.OrderRead, Permission.OrderPiiRead)
export class ProductionCommandController {
  constructor(@Inject(ProductionCommandService) private readonly commands: ProductionCommandService) {}
  @Get()
  @Header("Cache-Control", "private, no-store")
  list(@Req() request: AuthenticatedRequest, @Query() query: unknown) { return this.commands.list(context(request), parseRequestSchema(ProductionCommandQuerySchema, query)); }
  @Get(":id")
  @Header("Cache-Control", "private, no-store")
  get(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Query() query: unknown) {
    empty(query); return this.commands.get(context(request), id(value));
  }
  @Post()
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead)
  prepare(@Req() request: AuthenticatedRequest, @Body() body: unknown, @Query() query: unknown) {
    empty(query); return this.commands.prepare(context(request), parseRequestSchema(PrepareProductionCommandSchema, body));
  }
  @Post(":id/execute")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead)
  execute(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown, @Query() query: unknown) {
    empty(body); empty(query); return this.commands.execute(context(request), id(value));
  }
  @Post(":id/acknowledge")
  @Header("Cache-Control", "private, no-store")
  acknowledge(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown, @Query() query: unknown) {
    empty(body); empty(query); return this.commands.acknowledge(context(request), id(value));
  }
  @Post(":id/cancel")
  @Header("Cache-Control", "private, no-store")
  cancel(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown, @Query() query: unknown) {
    empty(body); empty(query); return this.commands.cancel(context(request), id(value));
  }
}
const empty = (value: unknown) => parseRequestSchema(z.object({}).strict(), value);
const id = (value: string) => parseRequestSchema(EntityIdSchema, value);
function context(request: AuthenticatedRequest) { if (!request.tenantContext) throw Error("Tenant context is required"); return request.tenantContext; }
