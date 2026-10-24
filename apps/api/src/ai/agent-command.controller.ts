import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { AgentCommandService } from "./agent-command.service.js";

@Controller("v1/agent-commands")
export class AgentCommandController {
  constructor(@Inject(AgentCommandService) private readonly service: AgentCommandService) {}
  @Get("workspace") @Header("Cache-Control", "private, no-store")
  workspace(@Req() request: AuthenticatedRequest) { return this.service.workspace(request.tenantContext!); }
  @Post("prepare") @Header("Cache-Control", "private, no-store")
  prepare(@Req() request: AuthenticatedRequest, @Body() raw: unknown) { return this.service.prepare(request.tenantContext!, raw); }
  @Post("adopt") @Header("Cache-Control", "private, no-store")
  adopt(@Req() request: AuthenticatedRequest, @Body() raw: unknown) { return this.service.adopt(request.tenantContext!, raw); }
  @Get("requests/:id") @Header("Cache-Control", "private, no-store")
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return this.service.get(request.tenantContext!, id); }
  @Get("receipts") @Header("Cache-Control", "private, no-store")
  receipt(@Req() request: AuthenticatedRequest, @Query() raw: unknown) { return this.service.receipt(request.tenantContext!, raw); }
  @Post("requests/:id/confirm") @HttpCode(200) @Header("Cache-Control", "private, no-store")
  confirm(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() raw: unknown) { return this.service.confirm(request.tenantContext!, id, raw); }
  @Post("requests/:id/cancel") @HttpCode(200) @Header("Cache-Control", "private, no-store")
  cancel(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() raw: unknown) { return this.service.cancel(request.tenantContext!, id, raw); }
  @Post("requests/:id/acknowledge") @HttpCode(200) @Header("Cache-Control", "private, no-store")
  acknowledge(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() raw: unknown) { return this.service.acknowledge(request.tenantContext!, id, raw); }
}
