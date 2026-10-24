import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { AgentLoopService } from "./agent-loop.service.js";

@Controller("v1/agent-loops")
export class AgentLoopController {
  constructor(@Inject(AgentLoopService) private readonly service: AgentLoopService) {}
  @Get("workspace") @Header("Cache-Control", "private, no-store")
  workspace(@Req() request: AuthenticatedRequest) { return this.service.workspace(request.tenantContext!); }
  @Post("runs") @Header("Cache-Control", "private, no-store")
  start(@Req() request: AuthenticatedRequest, @Body() raw: unknown) { return this.service.start(request.tenantContext!, raw); }
  @Get("runs/:id") @Header("Cache-Control", "private, no-store")
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return this.service.get(request.tenantContext!, id); }
  @Get("receipts") @Header("Cache-Control", "private, no-store")
  receipt(@Req() request: AuthenticatedRequest, @Query() raw: unknown) { return this.service.receipt(request.tenantContext!, raw); }
  @Post("runs/:id/stop") @HttpCode(200) @Header("Cache-Control", "private, no-store")
  stop(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() raw: unknown) { return this.service.stop(request.tenantContext!, id, raw); }
}
