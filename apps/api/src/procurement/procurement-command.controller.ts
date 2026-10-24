import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import { PrepareProcurementCommandSchema, ProcurementCommandQuerySchema, ProcurementCommandEmptyBodySchema } from "@yummyai/contracts/procurement/procurement-command";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { ProcurementCommandService } from "./procurement-command.service.js";

const id = z.uuidv7().transform(value => value.toLowerCase());
function input<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadRequestException("采购原请求参数无效 请重新核对");
  return parsed.data;
}
function context(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  authorize(request.tenantContext, Permission.ProcurementRead);
  return request.tenantContext;
}

@Controller("v1/procurement/commands")
export class ProcurementCommandController {
  constructor(@Inject(ProcurementCommandService) private readonly commands: ProcurementCommandService) {}
  @Post()
  @RequiresPermission(Permission.ProcurementRead)
  prepare(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const current = context(request);
    return this.commands.prepare(current, input(PrepareProcurementCommandSchema, body));
  }
  @Get()
  @RequiresPermission(Permission.ProcurementRead)
  list(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const current = context(request);
    return this.commands.list(current, input(ProcurementCommandQuerySchema, query));
  }
  @Get(":commandId")
  @RequiresPermission(Permission.ProcurementRead)
  command(@Req() request: AuthenticatedRequest, @Param("commandId") commandId: string) {
    const current = context(request);
    return this.commands.get(current, input(id, commandId));
  }
  @Post(":commandId/execute")
  @HttpCode(200)
  @RequiresPermission(Permission.ProcurementRead)
  execute(@Req() request: AuthenticatedRequest, @Param("commandId") commandId: string, @Body() body: unknown) {
    const current = context(request);
    input(ProcurementCommandEmptyBodySchema, body);
    return this.commands.execute(current, input(id, commandId));
  }
  @Post(":commandId/cancel")
  @HttpCode(200)
  @RequiresPermission(Permission.ProcurementRead)
  cancel(@Req() request: AuthenticatedRequest, @Param("commandId") commandId: string, @Body() body: unknown) {
    const current = context(request);
    input(ProcurementCommandEmptyBodySchema, body);
    return this.commands.cancel(current, input(id, commandId));
  }
  @Post(":commandId/acknowledge")
  @HttpCode(200)
  @RequiresPermission(Permission.ProcurementRead)
  acknowledge(@Req() request: AuthenticatedRequest, @Param("commandId") commandId: string, @Body() body: unknown) {
    const current = context(request);
    input(ProcurementCommandEmptyBodySchema, body);
    return this.commands.acknowledge(current, input(id, commandId));
  }
}
