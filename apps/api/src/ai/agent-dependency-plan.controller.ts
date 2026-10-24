import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { AgentDependencyPlanService } from "./agent-dependency-plan.service.js";

@Controller("v1/agent-dependency-plans")
export class AgentDependencyPlanController {
  constructor(@Inject(AgentDependencyPlanService) private readonly service: AgentDependencyPlanService) {}
  @Get("workspace") @Header("Cache-Control", "private, no-store")
  workspace(@Req() request: AuthenticatedRequest) { return this.service.workspace(request.tenantContext!); }
  @Get("requests") @Header("Cache-Control", "private, no-store")
  list(@Req() request: AuthenticatedRequest, @Query() raw: unknown) { return this.service.list(request.tenantContext!, raw); }
  @Post("requests") @HttpCode(201) @Header("Cache-Control", "private, no-store")
  create(@Req() request: AuthenticatedRequest, @Body() raw: unknown) { return this.service.create(request.tenantContext!, raw); }
  @Get("requests/:id") @Header("Cache-Control", "private, no-store")
  get(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return this.service.get(request.tenantContext!, id); }
  @Get("receipts") @Header("Cache-Control", "private, no-store")
  receipt(@Req() request: AuthenticatedRequest, @Query() raw: unknown) { return this.service.receipt(request.tenantContext!, raw); }
  @Post("requests/:id/prepare") @HttpCode(201) @Header("Cache-Control", "private, no-store")
  prepare(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() raw: unknown) { return this.service.prepare(request.tenantContext!, id, raw); }
  @Post("requests/:id/cancel") @HttpCode(200) @Header("Cache-Control", "private, no-store")
  cancel(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() raw: unknown) { return this.service.cancel(request.tenantContext!, id, raw); }
}
