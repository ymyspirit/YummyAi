import { Body, Controller, ForbiddenException, Get, Header, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { z } from "zod";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { parseRequestSchema } from "../request-schema.js";
import { AgentFulfillmentCommandService } from "./agent-fulfillment-command.service.js";

const empty = (raw: unknown) => parseRequestSchema(z.object({}).strict(), raw === undefined ? {} : raw);
function context(request: AuthenticatedRequest) {
  if (!request.tenantContext || request.authenticationKind !== "oidc")
    throw new ForbiddenException({ code: "agent_fulfillment_command_personal_session_required" });
  return request.tenantContext;
}

@Controller("v1/agent-fulfillment-commands")
@RequiresPermission(Permission.WorkflowRead)
export class AgentFulfillmentCommandController {
  constructor(@Inject(AgentFulfillmentCommandService) private readonly service: AgentFulfillmentCommandService) {}

  @Get("workspace") @Header("Cache-Control", "private, no-store")
  workspace(@Req() request: AuthenticatedRequest, @Query() query: unknown) { empty(query); return this.service.workspace(context(request)); }

  @Post("prepare") @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.WorkflowRead, Permission.WorkflowRun)
  prepare(@Req() request: AuthenticatedRequest, @Body() raw: unknown, @Query() query: unknown) { empty(query); return this.service.prepare(context(request), raw); }

  @Get("receipts") @Header("Cache-Control", "private, no-store")
  receipt(@Req() request: AuthenticatedRequest, @Query() query: unknown) { return this.service.receipt(context(request), query); }

  @Get("requests") @Header("Cache-Control", "private, no-store")
  list(@Req() request: AuthenticatedRequest, @Query() query: unknown) { return this.service.list(context(request), query); }

  @Get("requests/:id") @Header("Cache-Control", "private, no-store")
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query() query: unknown) { return this.service.get(context(request), id, query); }

  @Post("requests/:id/confirm") @HttpCode(200) @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.WorkflowRead, Permission.WorkflowRun)
  confirm(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() raw: unknown, @Query() query: unknown) { empty(query); return this.service.confirm(context(request), id, raw); }

  @Post("requests/:id/cancel") @HttpCode(200) @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.WorkflowRead, Permission.WorkflowRun)
  cancel(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() raw: unknown, @Query() query: unknown) { empty(query); return this.service.cancel(context(request), id, raw); }

  @Post("requests/:id/acknowledge") @HttpCode(200) @Header("Cache-Control", "private, no-store")
  @RequiresPermission(Permission.WorkflowRead, Permission.WorkflowRun)
  acknowledge(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() raw: unknown, @Query() query: unknown) { empty(query); return this.service.acknowledge(context(request), id, raw); }
}
