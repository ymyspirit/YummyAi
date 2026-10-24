import { Body, Controller, Get, Header, HttpCode, Inject, Post, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { AgentToolsService } from "./agent-tools.service.js";

/** Personal authenticated ERP boundary. API clients stay denied until separately verified. */
@Controller("v1/agent-tools")
export class AgentToolsController {
  constructor(@Inject(AgentToolsService) private readonly service: AgentToolsService) {}
  @Get("workspace") @Header("Cache-Control", "private, no-store")
  workspace(@Req() request: AuthenticatedRequest) { return this.service.workspace(request.tenantContext!); }
  @Post("definition") @HttpCode(200) @Header("Cache-Control", "private, no-store")
  definition(@Req() request: AuthenticatedRequest, @Body() raw: unknown) { return this.service.definition(request.tenantContext!, raw); }
  @Post("call") @HttpCode(200) @Header("Cache-Control", "private, no-store")
  call(@Req() request: AuthenticatedRequest, @Body() raw: unknown) { return this.service.call(request.tenantContext!, raw); }
}
