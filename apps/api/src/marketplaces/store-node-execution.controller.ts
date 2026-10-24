import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { CancelStoreNodeExecutionInputSchema, CreateStoreNodeExecutionInputSchema, StoreNodeExecutionReceiptInputSchema } from "@yummyai/contracts/marketplace/store-node-execution";
import type { ZodType } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { StoreNodeExecutionService } from "./store-node-execution.service.js";

@Controller("v1/marketplace-accounts/:id/node-executions")
export class StoreNodeExecutionController {
  constructor(@Inject(StoreNodeExecutionService) private readonly service: StoreNodeExecutionService) {}
  @Get() @RequiresPermission(Permission.StoreRead)
  workspace(@Req() req: AuthenticatedRequest, @Param("id") id: string) { return this.service.workspace(context(req), parse(EntityIdSchema, id)); }
  @Post() @RequiresPermission(Permission.StoreRead, Permission.StoreManage)
  create(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() raw: unknown) { return this.service.create(context(req), parse(EntityIdSchema, id), parse(CreateStoreNodeExecutionInputSchema, raw)); }
  @Get("history") @RequiresPermission(Permission.StoreRead)
  history(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Query("before") before?: string) { return this.service.history(context(req), parse(EntityIdSchema, id), before === undefined ? undefined : parse(EntityIdSchema, before)); }
  @Post("receipt") @HttpCode(200) @RequiresPermission(Permission.StoreRead)
  receipt(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Body() raw: unknown) { return this.service.receipt(context(req), parse(EntityIdSchema, id), parse(StoreNodeExecutionReceiptInputSchema, raw)); }
  @Get(":executionId") @RequiresPermission(Permission.StoreRead)
  get(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Param("executionId") executionId: string) { return this.service.get(context(req), parse(EntityIdSchema, id), parse(EntityIdSchema, executionId)); }
  @Post(":executionId/cancel") @HttpCode(200) @RequiresPermission(Permission.StoreRead, Permission.StoreManage)
  cancel(@Req() req: AuthenticatedRequest, @Param("id") id: string, @Param("executionId") executionId: string, @Body() raw: unknown) { return this.service.cancel(context(req), parse(EntityIdSchema, id), parse(EntityIdSchema, executionId), parse(CancelStoreNodeExecutionInputSchema, raw)); }
}
function context(req: AuthenticatedRequest) { if (!req.tenantContext) throw new Error("Tenant context is required"); return req.tenantContext; }
function parse<T>(schema: ZodType<T>, raw: unknown): T { const value = schema.safeParse(raw); if (!value.success) throw new BadRequestException({ code: "store_node_execution_input_invalid" }); return value.data; }
