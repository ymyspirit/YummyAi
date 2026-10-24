import { Body, Controller, Get, Header, HttpCode, Inject, Post, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { ApiClientMetadataRead, ApiClientVerifiedReadTools } from "../auth/api-client-route.guard.js";
import { AgentReadService } from "./agent-read.service.js";

@Controller("v1/agent-reads")
export class AgentReadController {
  constructor(@Inject(AgentReadService) private readonly service: AgentReadService) {}
  @Get("workspace") @ApiClientMetadataRead() @Header("Cache-Control", "private, no-store")
  workspace(@Req() request: AuthenticatedRequest) { return this.service.workspace(request.tenantContext!); }
  @Post("call") @HttpCode(200) @ApiClientVerifiedReadTools() @Header("Cache-Control", "private, no-store")
  call(@Req() request: AuthenticatedRequest, @Body() raw: unknown) { return this.service.call(request.tenantContext!, raw); }
}
