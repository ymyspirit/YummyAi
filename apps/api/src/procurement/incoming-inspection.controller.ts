import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { z } from "zod";
import { IncomingCommandEmptyBodySchema, IncomingCommandScopeSchema, PrepareIncomingCommandSchema } from "@yummyai/contracts/procurement/incoming-command";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { IncomingInspectionService } from "./incoming-inspection.service.js";
import { IncomingCommandService } from "./incoming-command.service.js";

const id = z.uuidv7().transform(value => value.toLowerCase());
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException("来料请求参数无效 请重新核对");
  return parsed.data;
}
function context(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}

@Controller("v1/procurement/incoming")
export class IncomingInspectionController {
  constructor(@Inject(IncomingInspectionService) private readonly service: IncomingInspectionService,
    @Inject(IncomingCommandService) private readonly commands: IncomingCommandService) {}

  @Post("commands")
  @RequiresPermission(Permission.ProcurementRead)
  prepare(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.commands.prepare(context(request), input(PrepareIncomingCommandSchema, body));
  }
  @Get("commands")
  @RequiresPermission(Permission.ProcurementRead)
  list(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.commands.list(context(request), input(IncomingCommandScopeSchema, query));
  }
  @Get("commands/:commandId")
  @RequiresPermission(Permission.ProcurementRead)
  command(@Req() request: AuthenticatedRequest, @Param("commandId") commandId: string) {
    return this.commands.get(context(request), input(id, commandId));
  }
  @Post("commands/:commandId/execute")
  @RequiresPermission(Permission.ProcurementRead)
  execute(@Req() request: AuthenticatedRequest, @Param("commandId") commandId: string, @Body() body: unknown) {
    input(IncomingCommandEmptyBodySchema, body ?? {});
    return this.commands.execute(context(request), input(id, commandId));
  }
  @Post("commands/:commandId/cancel")
  @RequiresPermission(Permission.ProcurementRead)
  cancel(@Req() request: AuthenticatedRequest, @Param("commandId") commandId: string, @Body() body: unknown) {
    input(IncomingCommandEmptyBodySchema, body ?? {});
    return this.commands.cancel(context(request), input(id, commandId));
  }
  @Post("commands/:commandId/acknowledge")
  @RequiresPermission(Permission.ProcurementRead)
  acknowledge(@Req() request: AuthenticatedRequest, @Param("commandId") commandId: string, @Body() body: unknown) {
    input(IncomingCommandEmptyBodySchema, body ?? {});
    return this.commands.acknowledge(context(request), input(id, commandId));
  }
  @Get("orders/:purchaseOrderId")
  @RequiresPermission(Permission.ProcurementRead)
  workspace(@Req() request: AuthenticatedRequest, @Param("purchaseOrderId") orderId: string) {
    return this.service.workspace(context(request), input(id, orderId));
  }
  @Get("orders/:purchaseOrderId/commands")
  @RequiresPermission(Permission.ProcurementRead)
  orderCommands(@Req() request: AuthenticatedRequest, @Param("purchaseOrderId") orderId: string, @Query() query: unknown) {
    const options = input(z.object({ before: id.optional() }).strict(), query);
    return this.commands.listForPurchaseOrder(context(request), input(id, orderId), options.before);
  }
  @Get("lines/:arrivalLineId")
  @RequiresPermission(Permission.ProcurementRead)
  line(@Req() request: AuthenticatedRequest, @Param("arrivalLineId") lineId: string) {
    return this.service.lineWorkspace(context(request), input(id, lineId));
  }
}
