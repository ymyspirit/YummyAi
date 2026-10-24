import { Body, Controller, Get, Header, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { RecordProductionMaterialSchema, ProductionMaterialsQuerySchema, ProductionMaterialRequestKeySchema } from "@yummyai/contracts/order/material-execution";
import { ProductionMaterialStockQuerySchema, ProductionMaterialReservationQuerySchema } from "@yummyai/contracts/order/material-execution";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { parseRequestSchema } from "../request-schema.js";
import { ProductionMaterialService } from "./production-material.service.js";
import { ProductionMaterialCommandService } from "./production-material-command.service.js";

@Controller("v1/production-orders/:id/materials")
@RequiresPermission(Permission.OrderRead, Permission.InventoryRead)
export class ProductionMaterialController {
  constructor(@Inject(ProductionMaterialService) private readonly materials: ProductionMaterialService,
    @Inject(ProductionMaterialCommandService) private readonly commands: ProductionMaterialCommandService) {}
  @Get("commands")
  @Header("Cache-Control", "private, no-store")
  listCommands(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Query() query: unknown) {
    empty(query); return this.commands.list(context(request), id(value));
  }
  @Get("commands/:commandId")
  @Header("Cache-Control", "private, no-store")
  command(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Param("commandId") commandId: string, @Query() query: unknown) {
    empty(query); return this.commands.get(context(request), id(value), id(commandId));
  }
  @Post("commands")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderWrite, Permission.InventoryRead, Permission.InventoryWrite)
  prepareCommand(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown, @Query() query: unknown) {
    empty(query); return this.commands.prepare(context(request), id(value), parseRequestSchema(RecordProductionMaterialSchema, body));
  }
  @Post("commands/:commandId/execute")
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderWrite, Permission.InventoryRead, Permission.InventoryWrite)
  executeCommand(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Param("commandId") commandId: string, @Body() body: unknown, @Query() query: unknown) {
    empty(body); empty(query); return this.commands.execute(context(request), id(value), id(commandId));
  }
  @Post("commands/:commandId/cancel")
  @Header("Cache-Control", "private, no-store")
  cancelCommand(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Param("commandId") commandId: string, @Body() body: unknown, @Query() query: unknown) {
    empty(body); empty(query); return this.commands.cancel(context(request), id(value), id(commandId));
  }
  @Post("commands/:commandId/acknowledge")
  @Header("Cache-Control", "private, no-store")
  acknowledgeCommand(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Param("commandId") commandId: string, @Body() body: unknown, @Query() query: unknown) {
    empty(body); empty(query); return this.commands.acknowledge(context(request), id(value), id(commandId));
  }
  @Get()
  @Header("Cache-Control", "private, no-store")
  workspace(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Query() query: unknown) {
    return this.materials.workspace(context(request), id(value), parseRequestSchema(ProductionMaterialsQuerySchema, query));
  }
  @Get("receipts/:key")
  @Header("Cache-Control", "private, no-store")
  receipt(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Param("key") key: string, @Query() query: unknown) {
    empty(query); return this.materials.receipt(context(request), id(value), parseRequestSchema(ProductionMaterialRequestKeySchema, key));
  }
  @Get("stock-options")
  @Header("Cache-Control", "private, no-store")
  stockOptions(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Query() query: unknown) {
    return this.materials.stockOptions(context(request), id(value), parseRequestSchema(ProductionMaterialStockQuerySchema, query));
  }
  @Get("entries/:entryId")
  @Header("Cache-Control", "private, no-store")
  entry(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Param("entryId") entryId: string, @Query() query: unknown) {
    empty(query); return this.materials.entry(context(request), id(value), id(entryId));
  }
  @Get("reservation-options")
  @Header("Cache-Control", "private, no-store")
  reservationOptions(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Query() query: unknown) {
    return this.materials.reservationOptions(context(request), id(value), parseRequestSchema(ProductionMaterialReservationQuerySchema, query));
  }
  @Post()
  @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.OrderRead, Permission.OrderWrite, Permission.InventoryRead, Permission.InventoryWrite)
  record(@Req() request: AuthenticatedRequest, @Param("id") value: string, @Body() body: unknown, @Query() query: unknown) {
    empty(query); return this.materials.record(context(request), id(value), parseRequestSchema(RecordProductionMaterialSchema, body));
  }
}
const empty = (value: unknown) => parseRequestSchema(z.object({}).strict(), value);
const id = (value: string) => parseRequestSchema(EntityIdSchema, value).toLowerCase();
function context(request: AuthenticatedRequest) { if (!request.tenantContext) throw Error("Tenant context is required"); return request.tenantContext; }
