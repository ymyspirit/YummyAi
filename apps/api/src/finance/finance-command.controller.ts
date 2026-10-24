import { BadRequestException, Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { FinanceCommandEmptyBodySchema, PrepareFinanceCommandSchema } from "@yummyai/contracts/finance/finance-command";
import { z } from "zod";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { FinanceCommandService } from "./finance-command.service.js";

const id = EntityIdSchema.transform(value => value.toLowerCase());
const emptyQuery = z.object({}).strict();
function input<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadRequestException({ code: "finance_command_input_invalid", message: "财务原提交填写或查询格式不正确" });
  return parsed.data;
}
function context(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}

/** Authentication supplies the tenant. Kind-specific OR authority belongs to
 * the service's current-membership transaction, never an AND route decorator. */
@Controller("v1/finance/commands")
export class FinanceCommandController {
  constructor(@Inject(FinanceCommandService) private readonly commands: FinanceCommandService) {}

  @Post()
  @HttpCode(201)
  @Header("Cache-Control", "private, no-store")
  prepare(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.commands.prepare(context(request), input(PrepareFinanceCommandSchema, body));
  }

  @Get()
  @Header("Cache-Control", "private, no-store")
  list(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    // The root query transforms to null and must be parsed exactly once.
    return this.commands.list(context(request), query);
  }

  @Get(":commandId")
  @Header("Cache-Control", "private, no-store")
  command(@Req() request: AuthenticatedRequest, @Param("commandId") rawId: string, @Query() query: unknown) {
    input(emptyQuery, query);
    return this.commands.get(context(request), input(id, rawId));
  }

  @Get(":commandId/original")
  @Header("Cache-Control", "private, no-store")
  original(@Req() request: AuthenticatedRequest, @Param("commandId") rawId: string, @Query() query: unknown) {
    input(emptyQuery, query);
    return this.commands.original(context(request), input(id, rawId));
  }

  @Get(":commandId/result")
  @Header("Cache-Control", "private, no-store")
  recordedResult(@Req() request: AuthenticatedRequest, @Param("commandId") rawId: string, @Query() query: unknown) {
    input(emptyQuery, query);
    return this.commands.recordedResult(context(request), input(id, rawId));
  }

  @Get(":commandId/result/entries")
  @Header("Cache-Control", "private, no-store")
  recordedResultEntries(@Req() request: AuthenticatedRequest, @Param("commandId") rawId: string, @Query() query: unknown) {
    return this.commands.recordedResultEntries(context(request), input(id, rawId), query);
  }

  @Post(":commandId/execute")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  execute(@Req() request: AuthenticatedRequest, @Param("commandId") rawId: string, @Body() body: unknown) {
    input(FinanceCommandEmptyBodySchema, body);
    return this.commands.execute(context(request), input(id, rawId));
  }

  @Post(":commandId/cancel")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  cancel(@Req() request: AuthenticatedRequest, @Param("commandId") rawId: string, @Body() body: unknown) {
    input(FinanceCommandEmptyBodySchema, body);
    return this.commands.cancel(context(request), input(id, rawId));
  }

  @Post(":commandId/acknowledge")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  acknowledge(@Req() request: AuthenticatedRequest, @Param("commandId") rawId: string, @Body() body: unknown) {
    input(FinanceCommandEmptyBodySchema, body);
    return this.commands.acknowledge(context(request), input(id, rawId));
  }
}
